/* sessionManager.js is the core of the app: PTYs live here, independent of any
 * WebSocket, which is what makes sessions survive reloads. Tests mock
 * spawnClaude() with a fake pty (onData/onExit/kill/resize/write, matching the
 * @lydell/node-pty API surface sessionManager actually calls) so no real
 * process is spawned, and spy on fs so nothing touches the real sessions.json.
 */
// describe/it/expect/vi/beforeEach/afterEach come from Vitest's `globals: true`
// (see vitest.config.ts) — Vitest 4 doesn't allow `require('vitest')`.
const fs = require('fs');

// vi.mock() intercepts ESM import graphs, not plain CommonJS require() calls
// (this file is CJS), and sessionManager.js destructures
// spawnClaude/hasClaudeHistory/readUsage out of these modules the instant
// it's required. So instead of vi.mock(), stub './claude' and './usage'
// directly in Node's require cache before (re-)requiring './sessionManager'
// each test — this also keeps the real @lydell/node-pty spawn out of the
// test entirely.
const CLAUDE_PATH = require.resolve('./claude');
const USAGE_PATH = require.resolve('./usage');
const SESSION_MANAGER_PATH = require.resolve('./sessionManager');

function fakePty() {
  const handlers = {};
  return {
    onData: (cb) => { handlers.data = cb; },
    onExit: (cb) => { handlers.exit = cb; },
    kill: vi.fn(),
    resize: vi.fn(),
    write: vi.fn(),
    _emitData: (d) => handlers.data && handlers.data(d),
    _emitExit: (exitCode = 0) => handlers.exit && handlers.exit({ exitCode }),
  };
}

describe('SessionManager', () => {
  let sessions, claude;

  beforeEach(() => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

    claude = { spawnClaude: vi.fn(), hasClaudeHistory: vi.fn(() => false) };
    require.cache[CLAUDE_PATH] = { id: CLAUDE_PATH, filename: CLAUDE_PATH, loaded: true, exports: claude };
    require.cache[USAGE_PATH] = { id: USAGE_PATH, filename: USAGE_PATH, loaded: true, exports: { readUsage: vi.fn(() => null) } };
    delete require.cache[SESSION_MANAGER_PATH];
    // Force a fresh SessionManager singleton each test WHILE fs.readFileSync
    // is still the real implementation — Node's own module loader uses
    // fs.readFileSync to read sessionManager.js's source off disk, so mocking
    // it to throw beforehand made every (re-)require of './sessionManager'
    // itself throw ENOENT. Only mock readFileSync afterward, for the app's
    // own reads (sessions.json inside restore()).
    sessions = require('./sessionManager');
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw new Error('ENOENT'); });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('create() spawns a pty, adds a running session, and persists to disk', () => {
    claude.spawnClaude.mockReturnValue(fakePty());
    const wire = sessions.create('C:\\proj', 80, 24);
    expect(wire.status).toBe('running');
    expect(wire.cwd).toBe('C:\\proj');
    expect(sessions.list()).toHaveLength(1);
    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  it('falls back to the home dir when cwd does not exist', () => {
    fs.existsSync.mockReturnValue(false);
    claude.spawnClaude.mockReturnValue(fakePty());
    const wire = sessions.create('C:\\gone', 80, 24);
    expect(wire.cwd).not.toBe('C:\\gone');
  });

  it('streams pty output as "data" events', () => {
    const pty = fakePty();
    claude.spawnClaude.mockReturnValue(pty);
    const onData = vi.fn();
    sessions.on('data', onData);
    const wire = sessions.create('C:\\proj', 80, 24);
    pty._emitData('hello\r\n');
    expect(onData).toHaveBeenCalledWith({ id: wire.id, data: 'hello\r\n' });
  });

  it('marks the session stopped + resumable on pty exit, without deleting it', () => {
    const pty = fakePty();
    claude.spawnClaude.mockReturnValue(pty);
    claude.hasClaudeHistory.mockReturnValue(true);
    const wire = sessions.create('C:\\proj', 80, 24);
    pty._emitExit(0);
    const [s] = sessions.list();
    expect(s.status).toBe('stopped');
    expect(s.resumable).toBe(true);
  });

  it('ignores a stale pty exit after restart (identity guard)', () => {
    const oldPty = fakePty();
    const newPty = fakePty();
    claude.spawnClaude.mockReturnValueOnce(oldPty).mockReturnValueOnce(newPty);
    const wire = sessions.create('C:\\proj', 80, 24);
    sessions.restart(wire.id, 80, 24); // swaps in newPty, kills oldPty
    oldPty._emitExit(1); // late exit event from the now-dead pty
    const [s] = sessions.list();
    expect(s.status).toBe('running'); // must not be clobbered by the stale exit
  });

  it('resume() spawns with { resume: true } so spawnClaude adds --continue', () => {
    claude.spawnClaude.mockReturnValueOnce(fakePty()).mockReturnValueOnce(fakePty());
    const wire = sessions.create('C:\\proj', 80, 24);
    sessions.resume(wire.id, 80, 24);
    expect(claude.spawnClaude).toHaveBeenLastCalledWith('C:\\proj', 80, 24, { resume: true });
  });

  it('attach() replays the scrollback buffer and resizes the pty', () => {
    const pty = fakePty();
    claude.spawnClaude.mockReturnValue(pty);
    const wire = sessions.create('C:\\proj', 80, 24);
    pty._emitData('scrollback so far');
    const replay = vi.fn();
    sessions.attach(wire.id, 100, 40, replay);
    expect(pty.resize).toHaveBeenCalledWith(100, 40);
    expect(replay).toHaveBeenCalledWith('scrollback so far');
  });

  it('input() writes to the pty and marks sawInput only on a carriage return', () => {
    const pty = fakePty();
    claude.spawnClaude.mockReturnValue(pty);
    const wire = sessions.create('C:\\proj', 80, 24);
    sessions.input(wire.id, 'partial typing');
    expect(pty.write).toHaveBeenCalledWith('partial typing');
    sessions.input(wire.id, '\r');
    expect(pty.write).toHaveBeenCalledWith('\r');
  });

  it('close() kills the pty, drops the session, and emits "closed"', () => {
    const pty = fakePty();
    claude.spawnClaude.mockReturnValue(pty);
    const wire = sessions.create('C:\\proj', 80, 24);
    const onClosed = vi.fn();
    sessions.on('closed', onClosed);
    sessions.close(wire.id);
    expect(pty.kill).toHaveBeenCalled();
    expect(sessions.list()).toHaveLength(0);
    expect(onClosed).toHaveBeenCalledWith({ id: wire.id });
  });

  it('restore() rehydrates persisted sessions as stopped ghosts, dropping ones whose folder is gone', () => {
    fs.readFileSync.mockReturnValue(JSON.stringify([
      { id: 'a', cwd: 'C:\\exists', title: 'exists' },
      { id: 'b', cwd: 'C:\\gone', title: 'gone' },
    ]));
    fs.existsSync.mockImplementation((p) => p === 'C:\\exists');
    claude.hasClaudeHistory.mockReturnValue(true);
    const count = sessions.restore();
    expect(count).toBe(1);
    const [s] = sessions.list();
    expect(s).toMatchObject({ id: 'a', status: 'stopped', resumable: true });
  });

  it('emits "idle" only when the user actually submitted a prompt', () => {
    vi.useFakeTimers();
    const pty = fakePty();
    claude.spawnClaude.mockReturnValue(pty);
    const wire = sessions.create('C:\\proj', 80, 24);
    const onIdle = vi.fn();
    sessions.on('idle', onIdle);

    // Output with no prior user input (e.g. startup banner) -> idle, but silent.
    pty._emitData('startup banner\r\n');
    vi.advanceTimersByTime(1600);
    expect(onIdle).not.toHaveBeenCalled();

    // User submits a prompt, Claude replies, then goes idle -> notify.
    sessions.input(wire.id, 'hello\r');
    pty._emitData('reply\r\n');
    vi.advanceTimersByTime(1600);
    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(onIdle).toHaveBeenCalledWith(expect.objectContaining({ id: wire.id }));
  });
});
