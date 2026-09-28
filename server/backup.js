/* Backup / restore — move this app's state to another machine.
 *
 * Two things have to travel together, and only one of them belongs to this app:
 *
 *   1. App state: `config.json` + `sessions.json`. Small, but every path in them
 *      is absolute, so they are NOT portable as-is.
 *   2. Conversation history: `~/.claude/projects/<slug>/`, owned by the Claude
 *      CLI, not by us. The slug is derived from the folder's absolute path
 *      (see claudeProjectDir), so on a machine where the project lives at a
 *      different path the transcript is present but unreachable.
 *
 * Hence `remap`: a restore can rewrite one root to another (C:\Users\me\proj ->
 * /home/me/proj) across the session list, the config, the project slugs, and the
 * `cwd` field inside each transcript record.
 *
 * What we deliberately DON'T rewrite: paths embedded in conversation content and
 * `trackingPath` entries. Those are a historical record of what happened on the
 * old machine — rewriting them would falsify the transcript, and nothing reads
 * them to locate anything. Only `cwd` and the slug are structural.
 *
 * The project FOLDERS themselves are not in the backup — they're git repos, and
 * copying gigabytes of node_modules onto a USB stick to reproduce something
 * `git clone` rebuilds in seconds is the wrong trade. So a v2 backup records
 * each project's remote + branch, and a restore clones them into the new root
 * before remapping (see `provision`). The consequence is that only PUSHED work
 * survives a restore, which is why planBackup() reports dirty/unpushed repos:
 * the UI warns about them, and the user decides (same posture as the busy-session
 * warning before an update restart).
 */
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { pipeline } = require('stream/promises');
const { execFile } = require('child_process');
const { promisify } = require('util');
const yazl = require('yazl');
const yauzl = require('yauzl');
const { claudeProjectDir } = require('./claude');

const execFileP = promisify(execFile);

const APP_ROOT = path.join(__dirname, '..');
const BACKUP_VERSION = 2;
// v1 backups have no `repos`/`commonRoot`, so they can't auto-provision, but
// they restore fine with an explicit remap. Keep reading them.
const SUPPORTED_VERSIONS = [1, 2];

// ---------------------------------------------------------------- path remap

// Compare two absolute paths for "is `p` inside `prefix`", tolerating separator
// and case differences (Windows is case-insensitive; a cross-platform restore
// mixes \ and / freely).
function pathStartsWith(p, prefix) {
  const norm = (s) => String(s).replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
  const a = norm(p);
  const b = norm(prefix);
  return a === b || a.startsWith(b + '/');
}

// Rewrite `p` if it sits under one of the mapped roots. The remainder's
// separators are converted to the target platform's, so a Windows path mapped
// onto a POSIX root comes out as a valid POSIX path rather than a hybrid.
function remapPath(p, rules) {
  if (typeof p !== 'string' || !p) return p;
  for (const { from, to } of rules) {
    if (!pathStartsWith(p, from)) continue;
    const rest = p.slice(from.replace(/[\\/]+$/, '').length);
    const sep = to.includes('\\') && !to.includes('/') ? '\\' : '/';
    const converted = rest.replace(/[\\/]+/g, sep);
    return to.replace(/[\\/]+$/, '') + converted;
  }
  return p;
}

// Normalize caller-supplied remap rules into a stable, longest-first list, so a
// nested root (…\Nocvault\sub) wins over its parent (…\Nocvault).
function normalizeRules(remap) {
  const rules = [];
  for (const [from, to] of Object.entries(remap || {})) {
    if (!from || !to) continue;
    if (pathStartsWith(from, to) && pathStartsWith(to, from)) continue; // no-op
    rules.push({ from, to });
  }
  rules.sort((a, b) => b.from.length - a.from.length);
  return rules;
}

// ------------------------------------------------------------------- helpers

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// Async for the same reason gitInfo is: this walks every transcript file (2267
// of them on a 12-project machine), and a synchronous version blocked the loop
// every PTY shares for ~200ms. Entries within a directory are statted together,
// which is also just faster.
// Each level returns its own total rather than accumulating into a shared
// variable. That is not a style preference: `total += (await stat(f)).size`
// reads `total` BEFORE evaluating the right-hand side, so with concurrent
// stats every suspended addition overwrites the ones that landed while it was
// awaiting. It silently under-reports — 435 MB for a real 972 MB, and a
// different wrong number each run.
async function dirSize(dir) {
  const walk = async (d) => {
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return 0; }
    const sizes = await Promise.all(entries.map(async (e) => {
      const full = path.join(d, e.name);
      if (e.isDirectory()) return walk(full);
      try { return (await fsp.stat(full)).size; } catch { return 0; /* vanished mid-walk */ }
    }));
    return sizes.reduce((a, b) => a + b, 0);
  };
  return walk(dir);
}

// The slug Claude Code uses for a folder — the tail of claudeProjectDir().
function projectSlug(cwd) {
  return path.basename(claudeProjectDir(cwd));
}

// ---------------------------------------------------------------- archive I/O

// Every file under `dir`, as paths relative to it. Used to enumerate a project's
// transcripts so they can be streamed into a zip without staging a copy first.
function walkFiles(dir, base = dir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(full, base));
    else out.push(path.relative(base, full));
  }
  return out;
}

// A backup is described as a flat list of entries — `{ to }` plus either a
// source path or a literal buffer — so the folder writer and the zip writer are
// two renderings of the same thing rather than two separate implementations.
function writeTree(destDir, entries) {
  for (const e of entries) {
    const dest = path.join(destDir, e.to);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (e.data) fs.writeFileSync(dest, e.data);
    else fs.copyFileSync(e.from, dest);
  }
}

// yazl reads each source lazily as it writes, so a 1 GB backup never has to fit
// in memory and no staging copy is needed.
//
// addReadStream, NOT addFile: addFile() stats the file first and then throws
// ("file data stream has unexpected number of bytes") if the stream delivers a
// different count. Transcripts are LIVE — the CLI appends to the .jsonl of every
// running session, quite possibly the session running this backup — so a file
// growing mid-read is the normal case, not an edge case. Given no size up front,
// yazl writes a data descriptor after each entry with the actual CRC and length,
// so whatever was read is what gets archived.
//
// A transcript caught mid-append can end on a half-written JSON line. That's
// fine: rewriteTranscript() passes unparseable lines through untouched, so a
// torn tail survives as-is instead of breaking the restore.
async function writeZip(destFile, entries) {
  const zip = new yazl.ZipFile();

  // yazl reports failures by emitting 'error' on the ZipFile, NOT on
  // outputStream — so pipeline() never sees them and an unhandled 'error' event
  // takes the whole server down. Turn it into a rejection we can return as a
  // failed backup. Reading a live directory can hit a file that was deleted or
  // locked between enumerating it and streaming it, so this is reachable.
  const failed = new Promise((_, reject) => zip.on('error', reject));

  for (const e of entries) {
    if (e.data) zip.addBuffer(e.data, e.to);
    else zip.addReadStream(fs.createReadStream(e.from), e.to);
  }
  zip.end();
  await Promise.race([
    pipeline(zip.outputStream, fs.createWriteStream(destFile)),
    failed,
  ]);
}

// Reject entry names that would escape the extraction root ("zip slip"), and
// normalize separators. A backup is usually one we wrote, but it arrives from
// another machine on removable media and is trivially editable, so treat its
// entry names as untrusted input rather than as our own output.
function safeEntryPath(destDir, name) {
  const cleaned = String(name).replace(/\\/g, '/').replace(/^\/+/, '');
  if (!cleaned || cleaned.split('/').some((seg) => seg === '..')) return null;
  const full = path.resolve(destDir, cleaned);
  const root = path.resolve(destDir);
  return full === root || full.startsWith(root + path.sep) ? full : null;
}

async function extractZip(srcFile, destDir) {
  const skipped = [];
  await new Promise((resolve, reject) => {
    yauzl.open(srcFile, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err) return reject(err);
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.readEntry();
      zip.on('entry', (entry) => {
        const target = safeEntryPath(destDir, entry.fileName);
        if (!target) { skipped.push(entry.fileName); return zip.readEntry(); }
        if (/\/$/.test(entry.fileName)) {
          fs.mkdirSync(target, { recursive: true });
          return zip.readEntry();
        }
        zip.openReadStream(entry, (e2, rs) => {
          if (e2) return reject(e2);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          const ws = fs.createWriteStream(target);
          rs.on('error', reject);
          ws.on('error', reject);
          ws.on('close', () => zip.readEntry());
          rs.pipe(ws);
        });
      });
    });
  });
  return { skipped };
}

// True when `dest` should be a single archive file rather than a folder tree.
function isZipPath(p) {
  return /\.zip$/i.test(String(p || ''));
}

// Give restoreBackup() a directory to read, whether it was handed a folder or a
// .zip. The caller must call cleanup() — it removes the temp extraction, if any.
async function openBackup(src) {
  let stat;
  try { stat = fs.statSync(src); } catch { return { ok: false, message: `${src} not found.` }; }

  if (stat.isDirectory()) return { ok: true, dir: src, cleanup: () => {} };

  if (!isZipPath(src)) {
    return { ok: false, message: `${src} is a file but not a .zip — point this at a backup folder or a .zip.` };
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cwui-restore-'));
  try {
    const { skipped } = await extractZip(src, tmp);
    return {
      ok: true, dir: tmp, skipped,
      cleanup: () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} },
    };
  } catch (err) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    return { ok: false, message: `Could not read ${src}: ${err.message}` };
  }
}

// --------------------------------------------------------------------- git

// Async, and deliberately so. These are local-only commands, but there are
// ~4 per project and this server is single-threaded with every session's PTY
// sharing the event loop: an earlier sync version spent 2.7s of solid blocking
// on 12 projects, which froze output in every terminal each time the Backup
// dialog was opened. Best-effort as before — a folder that isn't a repo, or a
// git that isn't installed, degrades to "not a repo" rather than breaking the
// whole plan.
async function git(args, cwd) {
  try {
    const { stdout } = await execFileP('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return String(stdout).trim();
  } catch {
    return null;
  }
}

// What a restore would need to reproduce `cwd`: the remote to clone and the
// branch to land on, plus whether anything here would NOT survive that clone.
//
// `unpushed` counts commits the upstream doesn't have. No upstream at all also
// counts as unpushed — the branch exists only on this machine, so a clone can't
// bring it back. Both counts are advisory; nothing here blocks a backup.
async function gitInfo(cwd) {
  const none = { isRepo: false, url: '', branch: '', dirty: 0, unpushed: 0 };
  if (!cwd || !fs.existsSync(cwd)) return none;

  const top = await git(['rev-parse', '--show-toplevel'], cwd);
  if (!top) return none;

  // A session opened *inside* a repo (rather than at its root) can't be restored
  // by cloning that repo to this path — the clone would land at the root, not
  // here. Treat it as a plain folder so the restore just creates the directory.
  const sameDir = (a, b) =>
    String(a).replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase() ===
    String(b).replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
  if (!sameDir(top, cwd)) return { ...none, nestedIn: top };

  // `status --porcelain -b` carries the branch, its upstream AND the ahead count
  // in its header line, on top of the dirty list — so one spawn answers what
  // previously took four. Spawning is the expensive part here: with these calls
  // fanned out across every project it was the only remaining source of
  // event-loop stall, and subprocess creation is partly synchronous in the parent.
  const [status, url] = await Promise.all([
    git(['status', '--porcelain', '-b'], cwd),
    git(['remote', 'get-url', 'origin'], cwd),
  ]);

  const lines = String(status || '').split('\n');
  const header = (lines.find((l) => l.startsWith('## ')) || '').slice(3).trim();
  const dirty = lines.filter((l) => l.trim() && !l.startsWith('## ')).length;

  // "main...origin/main [ahead 2, behind 1]" | "main" | "HEAD (no branch)"
  let branch = '';
  let upstream = '';
  let unpushed = 0;
  const tracked = header.match(/^(.+?)\.\.\.(\S+)(?:\s+\[(.+)\])?$/);
  if (tracked) {
    branch = tracked[1];
    upstream = tracked[2];
    const ahead = /ahead (\d+)/.exec(tracked[3] || '');
    unpushed = ahead ? Number(ahead[1]) : 0;
  } else {
    branch = header.replace(/\s*\(no branch\)$/, '').replace(/^No commits yet on\s+/, '');
  }

  // No upstream at all: every commit here is local-only as far as a clone is
  // concerned. Only then is a second round trip needed.
  if (!upstream) {
    const n = await git(['rev-list', '--count', '--max-count=999', 'HEAD'], cwd);
    unpushed = n ? Number(n) || 0 : 0;
  }

  return {
    isRepo: true,
    url: url || '',
    branch,
    dirty,
    unpushed,
    noUpstream: !upstream,
  };
}

// The deepest folder that contains every one of `paths` — the "old root" a
// restore remaps away from, so the user only has to name the new one.
//
// Compared case- and separator-insensitively (the paths may be Windows), but the
// returned value keeps the original spelling of the first path, because that is
// what actually appears in sessions.json and has to match for remapPath().
function commonRoot(paths) {
  const list = (paths || []).filter((p) => typeof p === 'string' && p);
  if (!list.length) return '';

  const split = (p) => p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').split('/');
  const first = split(list[0]);
  let len = first.length;
  for (const p of list.slice(1)) {
    const parts = split(p);
    let i = 0;
    while (i < len && i < parts.length && first[i].toLowerCase() === parts[i].toLowerCase()) i++;
    len = i;
  }
  if (!len) return '';

  // Rebuild from the original string so separators and case are preserved.
  const sep = list[0].includes('\\') && !list[0].includes('/') ? '\\' : '/';
  const rebuilt = first.slice(0, len).join(sep);
  // A bare Windows drive ("C:") needs its trailing separator to be a real root.
  return /^[a-zA-Z]:$/.test(rebuilt) ? rebuilt + sep : rebuilt;
}

// --------------------------------------------------------------------- plan

// What a backup WOULD contain, without writing anything. Lets the UI show the
// size before someone copies several GB of transcripts onto a USB stick.
async function planBackup(opts = {}) {
  const appRoot = opts.appRoot || APP_ROOT;
  const inspect = opts.gitInfo || gitInfo; // injectable so tests need no real repos
  const sessions = readJson(path.join(appRoot, 'sessions.json'), []) || [];

  // Unique folders first, then inspect them all at once. Sequentially this was
  // ~2.7s of blocked event loop on 12 projects; concurrently it costs about as
  // much as the slowest single repo. `inspect` may be a sync test double, which
  // Promise.all handles fine.
  const cwds = [];
  const seenCwd = new Set();
  for (const s of sessions) {
    if (!s || !s.cwd || seenCwd.has(s.cwd)) continue;
    seenCwd.add(s.cwd);
    cwds.push(s);
  }
  const built = await Promise.all(cwds.map(async (s) => {
    const dir = claudeProjectDir(s.cwd);
    const exists = fs.existsSync(dir);
    const [g, bytes] = await Promise.all([
      inspect(s.cwd),
      exists ? dirSize(dir) : 0,
    ]);
    const info = g || {};
    return {
      cwd: s.cwd,
      title: s.title || path.basename(s.cwd),
      slug: projectSlug(s.cwd),
      hasTranscripts: exists,
      bytes,
      // How a restore will recreate this folder: clone, or just mkdir.
      repo: info.isRepo && info.url ? { url: info.url, branch: info.branch } : null,
      dirty: info.dirty || 0,
      unpushed: info.unpushed || 0,
      noUpstream: !!info.noUpstream,
    };
  }));
  const projects = built;
  // Work that a clone-based restore would NOT bring back. Advisory only.
  const atRisk = projects
    .filter((p) => p.repo && (p.dirty || p.unpushed))
    .map((p) => ({ title: p.title, cwd: p.cwd, dirty: p.dirty, unpushed: p.unpushed, noUpstream: p.noUpstream }));
  return {
    sessionCount: sessions.length,
    projects,
    totalBytes: projects.reduce((n, p) => n + p.bytes, 0),
    commonRoot: commonRoot(projects.map((p) => p.cwd)),
    repoCount: projects.filter((p) => p.repo).length,
    plainCount: projects.filter((p) => !p.repo).length,
    atRisk,
  };
}

// ------------------------------------------------------------------- backup

// Copy this machine's app state (and optionally each session's transcripts) to
// `dest`, alongside a manifest describing where it all came from.
//
// `dest` ending in .zip produces a single file — one thing to carry to the other
// machine, and the transcripts are plain text so they compress hard. Anything
// else produces the same layout as a folder tree. Both are built from one entry
// list, so the two outputs can't drift apart.
async function createBackup(dest, opts = {}) {
  const includeTranscripts = opts.includeTranscripts !== false;
  const appRoot = opts.appRoot || APP_ROOT;
  if (!dest) return { ok: false, message: 'No destination given.' };

  const asZip = isZipPath(dest);
  if (asZip) {
    if (fs.existsSync(dest)) return { ok: false, message: `${dest} already exists.` };
    fs.mkdirSync(path.dirname(path.resolve(dest)), { recursive: true });
  } else if (fs.existsSync(dest) && fs.readdirSync(dest).length > 0) {
    return { ok: false, message: `${dest} already exists and is not empty.` };
  }

  const plan = await planBackup(opts);
  const manifest = {
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    platform: process.platform,
    homedir: os.homedir(),
    includeTranscripts,
    // The root every project path shares, so a restore can derive its own remap
    // from just the new folder the user picks.
    commonRoot: plan.commonRoot,
    projects: plan.projects.map((p) => ({
      cwd: p.cwd, title: p.title, slug: p.slug, hasTranscripts: p.hasTranscripts,
      // `repo` null means "not a git checkout" — the restore mkdirs it instead.
      repo: p.repo,
    })),
    // Recorded for the record, not read back: which folders had work that a
    // clone couldn't reproduce at the moment this backup was taken.
    atRisk: plan.atRisk,
  };

  const entries = [{ data: Buffer.from(JSON.stringify(manifest, null, 2)), to: 'manifest.json' }];
  for (const name of ['config.json', 'sessions.json']) {
    const src = path.join(appRoot, name);
    if (fs.existsSync(src)) entries.push({ from: src, to: 'app/' + name });
  }

  let copied = 0;
  if (includeTranscripts) {
    for (const p of plan.projects) {
      if (!p.hasTranscripts) continue;
      const dir = claudeProjectDir(p.cwd);
      for (const rel of walkFiles(dir)) {
        // Zip entry names are always '/'-separated, whatever this platform uses.
        entries.push({ from: path.join(dir, rel), to: `projects/${p.slug}/${rel.split(path.sep).join('/')}` });
      }
      copied++;
    }
  }

  if (asZip) await writeZip(dest, entries);
  else writeTree(dest, entries);

  const rawBytes = includeTranscripts ? plan.totalBytes : 0;
  let bytes = rawBytes;
  if (asZip) { try { bytes = fs.statSync(dest).size; } catch { /* keep the estimate */ } }

  return {
    ok: true,
    message: `Backed up ${plan.sessionCount} sessions and ${copied} project ` +
      `${copied === 1 ? 'history' : 'histories'}` +
      (asZip ? ` into one file (${Math.max(1, Math.round(bytes / 1048576))} MB).` : '.'),
    manifest,
    zipped: asZip,
    // What actually landed on disk, so the UI can show the compressed size.
    bytes,
    totalBytes: rawBytes,
  };
}

// ------------------------------------------------------------------ restore

// Rewrite a transcript into `destFile`, replacing only the structural `cwd`
// field. Streamed line by line — these files reach tens of megabytes, and a
// malformed line is passed through untouched rather than dropped.
async function rewriteTranscript(srcFile, destFile, rules) {
  const out = fs.createWriteStream(destFile);
  const rl = readline.createInterface({ input: fs.createReadStream(srcFile), crlfDelay: Infinity });
  let changed = 0;
  for await (const line of rl) {
    if (!line.trim()) { out.write(line + '\n'); continue; }
    let rec;
    try { rec = JSON.parse(line); } catch { out.write(line + '\n'); continue; }
    if (typeof rec.cwd === 'string') {
      const next = remapPath(rec.cwd, rules);
      if (next !== rec.cwd) { rec.cwd = next; changed++; }
    }
    out.write(JSON.stringify(rec) + '\n');
  }
  await new Promise((res, rej) => out.end((err) => (err ? rej(err) : res())));
  return changed;
}

// Read a backup produced by createBackup() and apply it to THIS machine.
//
// Two ways to say where things now live:
//   - `workDir`: the one folder that replaces the backup's recorded commonRoot.
//     This is the simple path — the remap is derived, and every project folder is
//     provisioned (git clone, or mkdir for non-repos) before anything else runs.
//   - `remap`: explicit old-root -> new-root pairs, provisioning nothing. Still
//     the only option for a v1 backup, which recorded no roots or remotes.
// Omit both to restore in place.
//
// Long-running once cloning is involved, so progress goes to `onLog` as it
// happens; the returned `log` is the same story without the raw git chatter.
// Accepts a backup folder or a .zip. A zip is extracted to a temp directory
// first and removed afterwards, so everything below only ever sees a directory.
async function restoreBackup(src, opts = {}) {
  const opened = await openBackup(src);
  if (!opened.ok) return { ok: false, message: opened.message };
  try {
    return await restoreFromDir(opened.dir, opts, opened.skipped || []);
  } finally {
    opened.cleanup();
  }
}

async function restoreFromDir(srcDir, opts = {}, unsafeEntries = []) {
  const manifestPath = path.join(srcDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, message: `No manifest.json in ${srcDir} — not a backup folder or archive.` };
  }
  const manifest = readJson(manifestPath, null);
  if (!manifest || !SUPPORTED_VERSIONS.includes(manifest.version)) {
    return { ok: false, message: `Unsupported backup version (${manifest && manifest.version}).` };
  }

  const appRoot = opts.appRoot || APP_ROOT;
  const log = [];
  const onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};
  const say = (line) => { log.push(line); onLog(line + '\n'); };

  for (const name of unsafeEntries) {
    say(`ignored unsafe archive entry "${name}" (would escape the extraction folder)`);
  }

  // --- where everything now lives
  let rules;
  if (opts.workDir) {
    if (!manifest.commonRoot) {
      return {
        ok: false,
        message: 'This backup does not record a root folder (it predates that), ' +
          'so a working folder cannot be derived. Give an explicit old -> new root instead.',
      };
    }
    rules = normalizeRules({ [manifest.commonRoot]: opts.workDir });
    say(`Mapping ${manifest.commonRoot} -> ${opts.workDir}`);
  } else {
    rules = normalizeRules(opts.remap);
  }

  // --- provision the project folders so the paths below actually exist.
  // Only for the workDir flow: an explicit remap means the user is pointing at
  // folders they already have, and cloning over them is not our call.
  const provision = opts.provision !== false && !!opts.workDir;
  const cloneOrPull = opts.cloneOrPull || (async (dest, repo, onData) => {
    // Reuse the app's own clone-or-pull, so this behaves exactly like Sync —
    // including its refusal to clone into a non-empty non-repo folder.
    const { syncRepo } = require('./git');
    return syncRepo(dest, onData, { repoUrl: repo.url, branch: repo.branch });
  });

  const targets = (manifest.projects || []).map((p) => ({
    title: p.title || p.cwd,
    repo: p.repo || null,
    dest: remapPath(p.cwd, rules),
  }));
  // Shallowest first. A parent that is itself a repo has to be cloned before
  // anything lands inside it — syncRepo refuses to clone into a non-empty folder,
  // so doing .../Nocvault/smb first would block .../Nocvault afterwards.
  const cloneOrder = [...targets].sort((a, b) => a.dest.length - b.dest.length);

  let provisioned = 0;
  let provisionFailed = 0;
  if (provision && !opts.dryRun) {
    say(`Preparing ${cloneOrder.length} project folders…`);
    for (const t of cloneOrder) {
      if (!t.repo) {
        fs.mkdirSync(t.dest, { recursive: true });
        say(`[${t.title}] folder created (not a git repo — nothing to clone)`);
        provisioned++;
        continue;
      }
      const r = await cloneOrPull(t.dest, t.repo, (d) => onLog(d));
      if (r && r.ok) { say(`[${t.title}] ${r.message}`); provisioned++; }
      else { say(`[${t.title}] FAILED — ${(r && r.message) || 'unknown error'}`); provisionFailed++; }
    }
  }

  // --- app state, with every recorded path remapped
  const sessions = (readJson(path.join(srcDir, 'app', 'sessions.json'), []) || [])
    .filter((s) => s && s.cwd)
    .map((s) => ({ ...s, cwd: remapPath(s.cwd, rules) }));

  const config = readJson(path.join(srcDir, 'app', 'config.json'), null);
  if (config) {
    if (Array.isArray(config.recents)) config.recents = config.recents.map((p) => remapPath(p, rules));
    if (Array.isArray(config.pinned)) config.pinned = config.pinned.map((p) => remapPath(p, rules));
    if (config.syncWorkDir) config.syncWorkDir = remapPath(config.syncWorkDir, rules);
    if (config.cwd) config.cwd = remapPath(config.cwd, rules);
  }

  // Drop sessions whose folder doesn't exist here — a ghost pointing at a path
  // that isn't on this machine is worse than no ghost at all.
  //
  // In a real run, provisioning has already happened, so the filesystem is the
  // only honest answer: a clone that FAILED must leave its session dropped, not
  // kept pointing at a folder that was never created. Only a dry run has to
  // predict, since it created nothing — otherwise every preview would report
  // every session as skipped.
  const norm = (p) => String(p).replace(/[\\/]+$/, '').toLowerCase();
  const wouldExist = new Set(
    provision && opts.dryRun ? targets.map((t) => norm(t.dest)) : []
  );
  const here = (p) => fs.existsSync(p) || wouldExist.has(norm(p));

  const kept = [];
  let dropped = 0;
  for (const s of sessions) {
    if (here(s.cwd)) kept.push(s);
    else { dropped++; say(`skipped session "${s.title || s.cwd}" — ${s.cwd} not found here`); }
  }

  if (opts.dryRun) {
    const plan = [];
    if (provision) {
      for (const t of cloneOrder) {
        plan.push(t.repo ? `would clone ${t.repo.url} -> ${t.dest}` : `would create ${t.dest}`);
      }
    }
    return {
      ok: true,
      dryRun: true,
      message: `Would restore ${kept.length} sessions (${dropped} skipped)` +
        (provision ? `, preparing ${cloneOrder.length} folders.` : '.'),
      log: [...log, ...plan],
      sessions: kept,
    };
  }

  if (config) fs.writeFileSync(path.join(appRoot, 'config.json'), JSON.stringify(config, null, 2));
  fs.writeFileSync(path.join(appRoot, 'sessions.json'), JSON.stringify(kept, null, 2));

  // --- transcripts, into the slug this machine will look under
  let restored = 0;
  const projectsDir = path.join(srcDir, 'projects');
  if (fs.existsSync(projectsDir)) {
    for (const p of manifest.projects || []) {
      const from = path.join(projectsDir, p.slug);
      if (!fs.existsSync(from)) continue;

      const newCwd = remapPath(p.cwd, rules);
      const to = claudeProjectDir(newCwd);
      if (fs.existsSync(to)) { log.push(`kept existing history for ${newCwd} (did not overwrite)`); continue; }

      fs.cpSync(from, to, { recursive: true });

      // Only touch the transcripts when the path actually moved.
      if (newCwd !== p.cwd) {
        for (const f of fs.readdirSync(to)) {
          if (!f.endsWith('.jsonl')) continue;
          const full = path.join(to, f);
          const tmp = full + '.remap';
          const n = await rewriteTranscript(full, tmp, rules);
          fs.renameSync(tmp, full);
          say(`remapped ${n} ${n === 1 ? 'record' : 'records'} in ${p.slug}/${f}`);
        }
      }
      restored++;
    }
  }

  return {
    ok: true,
    message: `Restored ${kept.length} sessions and ${restored} project ` +
      `${restored === 1 ? 'history' : 'histories'}` +
      (provision ? `, prepared ${provisioned} folders` : '') +
      (provisionFailed ? `, ${provisionFailed} failed to clone` : '') +
      (dropped ? `, skipped ${dropped} whose folder is missing here.` : '.'),
    log,
    provisioned,
    provisionFailed,
  };
}

module.exports = {
  BACKUP_VERSION, SUPPORTED_VERSIONS, planBackup, createBackup, restoreBackup,
  remapPath, pathStartsWith, normalizeRules, projectSlug, rewriteTranscript,
  gitInfo, commonRoot, isZipPath, safeEntryPath, walkFiles,
};
