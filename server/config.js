/* Persistent config — load/save config.json in the repo root.
 *
 * Config shape:
 * { repoUrl, branch, autoSync, autoResume, cwd, recents:[], pinned:[],
 *   syncWorkDir, syncRepos:[{name,url,branch}] }
 * recents/pinned are new in v2 and always default to []. syncWorkDir/syncRepos
 * back the "workspace sync" feature (Settings > Workspace repos) — a fixed
 * root folder plus a list of repos to clone/pull on demand, independent of
 * any session's own cwd (unlike repoUrl/branch, which sync INTO a session).
 */
const fs = require('fs');
const path = require('path');

// config.json lives in the repo root; this file is in server/, so go up one.
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

function loadConfig() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    raw = {};
  }
  // Normalize: ensure the new array fields always exist.
  return {
    repoUrl: raw.repoUrl || '',
    branch: raw.branch || '',
    autoSync: !!raw.autoSync,
    // Defaults ON, and note the `!== false` rather than `!!`: an older
    // config.json has no such key, and the wanted behaviour there is to auto
    // resume, not to fall back to the prompt it is replacing.
    autoResume: raw.autoResume !== false,
    cwd: raw.cwd || '',
    recents: Array.isArray(raw.recents) ? raw.recents : [],
    pinned: Array.isArray(raw.pinned) ? raw.pinned : [],
    syncWorkDir: raw.syncWorkDir || '',
    syncRepos: Array.isArray(raw.syncRepos) ? raw.syncRepos : [],
  };
}

function saveConfig(c) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
  } catch (err) {
    console.error('failed to save config:', err.message);
  }
}

module.exports = { loadConfig, saveConfig, CONFIG_PATH };
