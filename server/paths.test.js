/* Where the app keeps its state.
 *
 * This existed as a bug for the entire life of the Linux package. The app
 * writes config.json / sessions.json / server.pid beside its own code, which is
 * fine on Windows (per-user install, or your own checkout) but not under a .deb:
 * /opt/claude-web-ui belongs to root and the app runs as you. Every write was
 * denied — silently, because saveConfig() and _persist() both swallow errors.
 * The server came up, served the UI, and simply never remembered anything: no
 * pidfile for the stop script, no session list across a restart, no settings,
 * and nothing for a backup to collect.
 *
 * Only running it on Linux as a non-root user showed this. These tests pin the
 * decision so it can't quietly regress.
 *
 * describe/it/expect/vi come from Vitest's `globals: true` (see vitest.config.ts).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const PATHS_SRC = require.resolve('./paths');

function loadPaths(env = {}) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  delete require.cache[PATHS_SRC];
  try {
    return require('./paths');
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

afterEach(() => { delete require.cache[PATHS_SRC]; });

describe('isWritable', () => {
  const { isWritable } = require('./paths');

  it('says yes for a directory we can write', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cwui-w-'));
    try { expect(isWritable(d)).toBe(true); } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });

  it('says no for a directory that does not exist', () => {
    expect(isWritable(path.join(os.tmpdir(), 'cwui-definitely-not-here-' + Date.now()))).toBe(false);
  });

  it('leaves no probe file behind', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cwui-w-'));
    try {
      isWritable(d);
      expect(fs.readdirSync(d)).toEqual([]);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
});

describe('state location', () => {
  it('uses the app directory when it is writable', () => {
    // The normal case on Windows and in a dev checkout — and the reason this
    // change needs no migration for anyone already running.
    const p = loadPaths();
    expect(p.STATE_DIR).toBe(p.APP_DIR);
    expect(p.stateIsElsewhere).toBe(false);
  });

  it('honours XDG_STATE_HOME for the fallback location', () => {
    // userStateDir() reads the environment when called, not when required, so
    // the variable has to still be set at the point of the call.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cwui-xdg-'));
    const saved = process.env.XDG_STATE_HOME;
    try {
      process.env.XDG_STATE_HOME = base;
      expect(require('./paths').userStateDir()).toBe(path.join(base, 'claude-web-ui'));
    } finally {
      if (saved === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = saved;
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('keeps state per-application, not loose in the state root', () => {
    const p = require('./paths');
    expect(path.basename(p.userStateDir())).toBe('claude-web-ui');
  });

  it('names exactly the files that travel together', () => {
    // server.pid is deliberately absent: it is derived at runtime, and copying
    // a stale one into a fresh state dir would point the stop script at a pid
    // that means nothing.
    expect(require('./paths').STATE_FILES).toEqual(['config.json', 'sessions.json']);
  });
});

describe('the state files actually follow STATE_DIR', () => {
  // The bug was not in choosing a directory, it was in four modules each
  // deriving their own path from __dirname. If any of them drifts back, the
  // app half-persists — which is worse than not persisting at all.
  const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');

  it('config.json comes from STATE_DIR', () => {
    expect(read('config.js')).toMatch(/CONFIG_PATH\s*=\s*path\.join\(STATE_DIR/);
  });

  it('sessions.json comes from STATE_DIR', () => {
    expect(read('sessionManager.js')).toMatch(/SESSIONS_PATH\s*=\s*path\.join\(require\('\.\/paths'\)\.STATE_DIR/);
  });

  it('server.pid comes from STATE_DIR', () => {
    expect(read('index.js')).toMatch(/PID_PATH\s*=\s*path\.join\(paths\.STATE_DIR/);
  });

  it('backup reads and writes state from STATE_DIR', () => {
    expect(read('backup.js')).toMatch(/APP_ROOT\s*=\s*require\('\.\/paths'\)\.STATE_DIR/);
  });

  it('but the CODE paths still point at the install, not the state dir', () => {
    // web/dist and package.json ship with the app and must not follow state.
    const idx = read('index.js');
    expect(idx).toMatch(/distDir\s*=\s*path\.join\(__dirname, '\.\.', 'web', 'dist'\)/);
  });
});
