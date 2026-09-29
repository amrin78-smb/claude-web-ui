/* Where the app's code lives, and where its state lives — which are not always
 * the same directory.
 *
 * The app writes `config.json`, `sessions.json` and `server.pid` next to its own
 * code, which has always worked on Windows: the installer is per-user
 * (%LOCALAPPDATA%\Programs\...) and a dev checkout is yours anyway.
 *
 * On Linux it doesn't. The .deb installs to /opt/claude-web-ui owned by root,
 * while the app is meant to run as *you* — so every one of those writes was
 * denied. It failed silently, too: the server started, served the UI, and
 * simply never persisted anything. No pidfile (so the stop script couldn't find
 * it), no session list surviving a restart, no saved settings, and nothing for
 * a backup to collect.
 *
 * So: keep using the app directory whenever it is actually writable — which
 * leaves every existing install exactly where it is, with no migration and no
 * chance of stranding someone's session list — and fall back to a per-user
 * state directory only when it isn't.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// Where the code is. Never written to at runtime (the dev-only self-update is
// the one exception, and that path is a git checkout by definition).
const APP_DIR = path.join(__dirname, '..');

// Probe rather than reason about it: "is /opt writable" depends on how the
// package was installed, whether the user is root, and on Windows whether the
// install landed under Program Files. Trying is cheaper than predicting, and it
// happens once at startup.
function isWritable(dir) {
  const probe = path.join(dir, '.write-probe-' + process.pid);
  try {
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

// The conventional per-user spot for state a program manages itself: XDG on
// Linux, LOCALAPPDATA on Windows.
function userStateDir() {
  const base = process.env.XDG_STATE_HOME
    || (process.platform === 'win32'
      ? (process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'))
      : path.join(os.homedir(), '.local', 'state'));
  return path.join(base, 'claude-web-ui');
}

// These are the files that move together. Anything else the app writes at
// runtime belongs to a session's own folder, not here.
const STATE_FILES = ['config.json', 'sessions.json'];

function resolveStateDir() {
  if (isWritable(APP_DIR)) return APP_DIR;

  const dir = userStateDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Nowhere to write at all. Returning the app dir keeps the old behaviour —
    // the writes still fail, but nothing new breaks, and the server starts.
    return APP_DIR;
  }

  // Seed from the install directory once, for the case where state was written
  // there by someone who could (root ran it first, or a package shipped one).
  // Only when we have nothing of our own — never overwrite the user's state.
  for (const name of STATE_FILES) {
    const mine = path.join(dir, name);
    const theirs = path.join(APP_DIR, name);
    try {
      if (!fs.existsSync(mine) && fs.existsSync(theirs)) fs.copyFileSync(theirs, mine);
    } catch { /* a seed that fails is not worth failing startup over */ }
  }
  return dir;
}

const STATE_DIR = resolveStateDir();

module.exports = {
  APP_DIR,
  STATE_DIR,
  // True when state had to move out of the install directory — worth saying out
  // loud at startup, since it changes where someone looks for their files.
  stateIsElsewhere: STATE_DIR !== APP_DIR,
  isWritable,
  userStateDir,
  STATE_FILES,
};
