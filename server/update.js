/* Self-update — pull latest code from the app's own git remote, npm install,
 * rebuild the frontend, then hand back a signal so the caller (server/index.js)
 * can restart the server process. Modeled closely on git.js's syncRepo():
 * streams output via onData, never throws.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { runGit } = require('./git');

// Run an arbitrary command, streaming stdout+stderr to onData. Resolves with
// { code }. Never rejects. Same shape as git.js's runGit(), but for any
// command. On Windows, `shell:true` is required for spawn() to resolve/exec
// a .cmd shim (e.g. npm.cmd) the way a real shell would.
function runCmd(cmd, args, cwd, onData) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, shell: process.platform === 'win32' });
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
async function runUpdate(onData) {
  const appRoot = path.join(__dirname, '..');

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

module.exports = { runUpdate, runCmd };
