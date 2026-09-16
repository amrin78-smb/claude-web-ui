/* Self-update — two paths, chosen at INSTALL time rather than guessed here.
 *
 *   dev (a git checkout):  pull + npm install + npm run build, then signal a
 *                          restart. The original behaviour, and still the
 *                          default whenever no install marker is present.
 *   packaged (.exe/.deb):  there is no .git to pull, and the install directory
 *                          is usually not user-writable anyway, so the app
 *                          checks the release feed and points at the new
 *                          installer instead of trying to rewrite itself.
 *
 * scripts/package.js writes install-mode.json into the staged tree; its absence
 * means a git checkout.
 *
 * Modeled closely on git.js's syncRepo(): streams output via onData, never
 * throws.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { runGit } = require('./git');

const APP_ROOT = path.join(__dirname, '..');
// Where a packaged build looks for new versions — the same repo the dev path pulls.
const RELEASE_API = 'https://api.github.com/repos/amrin78-smb/claude-web-ui/releases/latest';

// How this copy was installed. Anything absent or unreadable is treated as a git
// checkout, which keeps every existing install working exactly as before.
function installMode(appRoot = APP_ROOT) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(appRoot, 'install-mode.json'), 'utf8'));
    return raw && raw.mode === 'packaged' ? raw : { mode: 'dev' };
  } catch {
    return { mode: 'dev' };
  }
}

// Compare two "2.3.10"-style versions. Returns > 0 when a is newer than b.
function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// Ask the release feed for the newest published version and the asset matching
// this build's target. Never throws — a packaged app with no network should say
// so plainly, not fall over.
async function checkRelease(marker, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  let release;
  try {
    const res = await doFetch(RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'claude-web-ui' },
    });
    if (!res.ok) return { ok: false, message: `Release check failed (HTTP ${res.status}).` };
    release = await res.json();
  } catch (err) {
    return { ok: false, message: `Release check failed: ${err.message}` };
  }

  const latest = String((release && release.tag_name) || '').replace(/^v/, '');
  if (!latest) return { ok: false, message: 'Release feed returned no version.' };
  if (compareVersions(latest, marker.version) <= 0) {
    return { ok: true, upToDate: true, latest, message: `Already on the latest version (${marker.version}).` };
  }

  // Pick the asset for this build's platform: .exe for Windows, .deb for Linux.
  const wantExt = String(marker.target || '').startsWith('win32') ? '.exe' : '.deb';
  const asset = (release.assets || []).find((a) => String(a.name || '').endsWith(wantExt));
  return {
    ok: true,
    upToDate: false,
    latest,
    url: (asset && asset.browser_download_url) || release.html_url,
    message: `Version ${latest} is available (you have ${marker.version}).`,
  };
}

// Run an arbitrary command, streaming stdout+stderr to onData. Resolves with
// { code }. Never rejects. Same shape as git.js's runGit(), but for any
// command. `shell:true` is required on Windows: npm's launcher is npm.cmd, a
// batch shim, and CreateProcess can't execute those directly (plain
// child_process.spawn throws EINVAL — unlike node-pty, which handles this
// itself; see claude.js/CLAUDE.md for the analogous node-pty gotcha). Command
// + args are joined into a single string rather than passed as a separate
// args array, which avoids Node's DEP0190 warning (shell:true + an args array
// means the args are concatenated, not escaped) — safe here since every
// caller passes fixed literal args (['install'], ['run', 'build']), never
// anything user-supplied.
function runCmd(cmd, args, cwd, onData) {
  return new Promise((resolve) => {
    // spawn() can throw SYNCHRONOUSLY for some invalid argument combinations
    // (seen firsthand: EINVAL from an earlier version of this function) —
    // uncaught, that would crash the whole live server, not just fail this
    // update. Never let that happen: report it the same way an async
    // 'error' event below is reported.
    let child;
    try {
      child = spawn([cmd, ...args].join(' '), { cwd, shell: true });
    } catch (err) {
      onData(`${cmd} error: ${err.message}\n`);
      resolve({ code: -1 });
      return;
    }
    child.stdout.on('data', d => onData(d.toString()));
    child.stderr.on('data', d => onData(d.toString()));
    child.on('error', (err) => {
      onData(`${cmd} error: ${err.message}\n`);
      resolve({ code: -1 });
    });
    child.on('close', (code) => resolve({ code }));
  });
}

// Pull latest code, `npm install`, `npm run build` — all in the APP's own
// root (path.join(__dirname, '..'), never a session's cwd). Streams all
// output via onData. Resolves with { ok, message, shouldRestart }. Never
// throws — every failure path returns { ok:false } instead, and stops before
// running the next step (never installs/builds after a failed pull, never
// signals a restart into a broken build).
async function runUpdate(onData, opts = {}) {
  const appRoot = (opts && opts.appRoot) || APP_ROOT;
  const marker = installMode(appRoot);

  // Packaged install: check the feed, never try to rewrite the install dir.
  if (marker.mode === 'packaged') {
    onData(`Installed: ${marker.version} (${marker.target}) — checking for updates…\n`);
    const r = await checkRelease(marker, opts && opts.fetchImpl);
    onData(r.message + '\n');
    if (r.ok && !r.upToDate && r.url) {
      onData(`Download: ${r.url}\n`);
      onData('Installing it replaces this copy; your sessions and history are untouched.\n');
    }
    // Never a restart: nothing on disk changed.
    return { ok: r.ok, message: r.message, url: r.url, latest: r.latest, shouldRestart: false };
  }

  if (!fs.existsSync(path.join(appRoot, '.git'))) {
    onData('This app folder is not a git repo — nothing to pull.\n');
    return { ok: false, message: 'not a git repo' };
  }

  onData('Pulling latest...\n');
  const pull = await runGit(['pull', '--ff-only'], appRoot, onData);
  if (pull.code !== 0) {
    onData(
      'Pull failed (local changes, a non-fast-forward, or no network).\n' +
      'Resolve the issue in the app folder, then update again.\n'
    );
    return { ok: false, message: 'pull failed' };
  }

  onData('Running npm install...\n');
  const install = await runCmd('npm', ['install'], appRoot, onData);
  if (install.code !== 0) {
    onData('npm install failed — leaving the running server as-is.\n');
    return { ok: false, message: 'npm install failed' };
  }

  onData('Building frontend...\n');
  const build = await runCmd('npm', ['run', 'build'], appRoot, onData);
  if (build.code !== 0) {
    onData('npm run build failed — leaving the running server as-is.\n');
    return { ok: false, message: 'build failed' };
  }

  onData('Update complete.\n');
  return { ok: true, message: 'Update complete', shouldRestart: true };
}

module.exports = { runUpdate, runCmd, installMode, compareVersions, checkRelease };
