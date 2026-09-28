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
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execFileSync } = require('child_process');
const { claudeProjectDir } = require('./claude');

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

function dirSize(dir) {
  let bytes = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else { try { bytes += fs.statSync(full).size; } catch {} }
    }
  };
  walk(dir);
  return bytes;
}

// The slug Claude Code uses for a folder — the tail of claudeProjectDir().
function projectSlug(cwd) {
  return path.basename(claudeProjectDir(cwd));
}

// --------------------------------------------------------------------- git

// Synchronous, because planBackup() is called from a ws handler that has to
// answer in one message, and these are all local-only commands (no network).
// Every one is best-effort: a folder that isn't a repo, or a git that isn't
// installed, must degrade to "not a repo" rather than break the whole plan.
function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }).trim();
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
function gitInfo(cwd) {
  const none = { isRepo: false, url: '', branch: '', dirty: 0, unpushed: 0 };
  if (!cwd || !fs.existsSync(cwd)) return none;

  const top = git(['rev-parse', '--show-toplevel'], cwd);
  if (!top) return none;

  // A session opened *inside* a repo (rather than at its root) can't be restored
  // by cloning that repo to this path — the clone would land at the root, not
  // here. Treat it as a plain folder so the restore just creates the directory.
  const sameDir = (a, b) =>
    String(a).replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase() ===
    String(b).replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
  if (!sameDir(top, cwd)) return { ...none, nestedIn: top };

  const branch = git(['branch', '--show-current'], cwd) || '';
  const dirty = (git(['status', '--porcelain'], cwd) || '')
    .split('\n').filter((l) => l.trim()).length;

  let unpushed = 0;
  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], cwd);
  if (!upstream) {
    // No upstream: every commit on this branch is local-only as far as a clone
    // is concerned. Count them, but cap the work with --max-count.
    const n = git(['rev-list', '--count', '--max-count=999', 'HEAD'], cwd);
    unpushed = n ? Number(n) || 0 : 0;
  } else {
    const n = git(['rev-list', '--count', upstream + '..HEAD'], cwd);
    unpushed = n ? Number(n) || 0 : 0;
  }

  return {
    isRepo: true,
    url: git(['remote', 'get-url', 'origin'], cwd) || '',
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
function planBackup(opts = {}) {
  const appRoot = opts.appRoot || APP_ROOT;
  const inspect = opts.gitInfo || gitInfo; // injectable so tests need no real repos
  const sessions = readJson(path.join(appRoot, 'sessions.json'), []) || [];
  const seen = new Map();
  for (const s of sessions) {
    if (!s || !s.cwd || seen.has(s.cwd)) continue;
    const dir = claudeProjectDir(s.cwd);
    const exists = fs.existsSync(dir);
    const g = inspect(s.cwd);
    seen.set(s.cwd, {
      cwd: s.cwd,
      title: s.title || path.basename(s.cwd),
      slug: projectSlug(s.cwd),
      hasTranscripts: exists,
      bytes: exists ? dirSize(dir) : 0,
      // How a restore will recreate this folder: clone, or just mkdir.
      repo: g.isRepo && g.url ? { url: g.url, branch: g.branch } : null,
      dirty: g.dirty || 0,
      unpushed: g.unpushed || 0,
      noUpstream: !!g.noUpstream,
    });
  }
  const projects = [...seen.values()];
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

// Copy this machine's app state (and optionally each session's transcripts)
// into `destDir`, alongside a manifest describing where it all came from.
function createBackup(destDir, opts = {}) {
  const includeTranscripts = opts.includeTranscripts !== false;
  const appRoot = opts.appRoot || APP_ROOT;
  if (!destDir) return { ok: false, message: 'No destination folder given.' };

  if (fs.existsSync(destDir) && fs.readdirSync(destDir).length > 0) {
    return { ok: false, message: `${destDir} already exists and is not empty.` };
  }
  fs.mkdirSync(path.join(destDir, 'app'), { recursive: true });

  const plan = planBackup(opts);
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

  for (const name of ['config.json', 'sessions.json']) {
    const src = path.join(appRoot, name);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(destDir, 'app', name));
  }

  let copied = 0;
  if (includeTranscripts) {
    for (const p of plan.projects) {
      if (!p.hasTranscripts) continue;
      fs.cpSync(claudeProjectDir(p.cwd), path.join(destDir, 'projects', p.slug), { recursive: true });
      copied++;
    }
  }

  fs.writeFileSync(path.join(destDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return {
    ok: true,
    message: `Backed up ${plan.sessionCount} sessions and ${copied} project ` +
      `${copied === 1 ? 'history' : 'histories'}.`,
    manifest,
    totalBytes: includeTranscripts ? plan.totalBytes : 0,
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
async function restoreBackup(srcDir, opts = {}) {
  const manifestPath = path.join(srcDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, message: `No manifest.json in ${srcDir} — not a backup folder.` };
  }
  const manifest = readJson(manifestPath, null);
  if (!manifest || !SUPPORTED_VERSIONS.includes(manifest.version)) {
    return { ok: false, message: `Unsupported backup version (${manifest && manifest.version}).` };
  }

  const appRoot = opts.appRoot || APP_ROOT;
  const log = [];
  const onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};
  const say = (line) => { log.push(line); onLog(line + '\n'); };

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
  gitInfo, commonRoot,
};
