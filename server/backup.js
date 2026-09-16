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
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { claudeProjectDir } = require('./claude');

const APP_ROOT = path.join(__dirname, '..');
const BACKUP_VERSION = 1;

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

// --------------------------------------------------------------------- plan

// What a backup WOULD contain, without writing anything. Lets the UI show the
// size before someone copies several GB of transcripts onto a USB stick.
function planBackup(opts = {}) {
  const appRoot = opts.appRoot || APP_ROOT;
  const sessions = readJson(path.join(appRoot, 'sessions.json'), []) || [];
  const seen = new Map();
  for (const s of sessions) {
    if (!s || !s.cwd || seen.has(s.cwd)) continue;
    const dir = claudeProjectDir(s.cwd);
    const exists = fs.existsSync(dir);
    seen.set(s.cwd, {
      cwd: s.cwd,
      title: s.title || path.basename(s.cwd),
      slug: projectSlug(s.cwd),
      hasTranscripts: exists,
      bytes: exists ? dirSize(dir) : 0,
    });
  }
  const projects = [...seen.values()];
  return {
    sessionCount: sessions.length,
    projects,
    totalBytes: projects.reduce((n, p) => n + p.bytes, 0),
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
    projects: plan.projects.map((p) => ({
      cwd: p.cwd, title: p.title, slug: p.slug, hasTranscripts: p.hasTranscripts,
    })),
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
// `remap` maps old roots to new ones ({ 'C:\\Users\\me\\proj': '/home/me/proj' });
// omit it to restore in place.
async function restoreBackup(srcDir, opts = {}) {
  const manifestPath = path.join(srcDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, message: `No manifest.json in ${srcDir} — not a backup folder.` };
  }
  const manifest = readJson(manifestPath, null);
  if (!manifest || manifest.version !== BACKUP_VERSION) {
    return { ok: false, message: `Unsupported backup version (${manifest && manifest.version}).` };
  }

  const rules = normalizeRules(opts.remap);
  const appRoot = opts.appRoot || APP_ROOT;
  const log = [];

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
  const kept = [];
  let dropped = 0;
  for (const s of sessions) {
    if (fs.existsSync(s.cwd)) kept.push(s);
    else { dropped++; log.push(`skipped session "${s.title || s.cwd}" — ${s.cwd} not found here`); }
  }

  if (opts.dryRun) {
    return { ok: true, dryRun: true, message: `Would restore ${kept.length} sessions (${dropped} skipped).`, log, sessions: kept };
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
          log.push(`remapped ${n} ${n === 1 ? 'record' : 'records'} in ${p.slug}/${f}`);
        }
      }
      restored++;
    }
  }

  return {
    ok: true,
    message: `Restored ${kept.length} sessions and ${restored} project ` +
      `${restored === 1 ? 'history' : 'histories'}` +
      (dropped ? `, skipped ${dropped} whose folder is missing here.` : '.'),
    log,
  };
}

module.exports = {
  BACKUP_VERSION, planBackup, createBackup, restoreBackup,
  remapPath, pathStartsWith, normalizeRules, projectSlug, rewriteTranscript,
};
