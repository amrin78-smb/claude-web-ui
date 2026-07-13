/* Exercises runUpdate()'s orchestration logic (no-repo / pull-fails /
 * install-fails / build-fails / full-success) with git.js's runGit() and
 * child_process's spawn() stubbed out, so this never shells out to a real
 * git/npm.
 */
// describe/it/expect/vi/beforeEach/afterEach come from Vitest's `globals: true`
// (see vitest.config.ts) — Vitest 4 doesn't allow `require('vitest')`.
const fs = require('fs');
const { EventEmitter } = require('events');

// vi.mock() intercepts ESM import graphs, not plain CommonJS require() calls
// (this file is CJS), and update.js destructures runGit/spawn out of './git'
// and 'child_process' the instant it's required (see claude.test.js and
// sessionManager.test.js for the same finding). So instead of vi.mock():
//  - replace the real child_process.spawn with a vi.fn() before './update'
//    is required the first time, so update.js's destructured reference is
//    the mock, not the real function (same trick claude.test.js uses for
//    execSync);
//  - stub './git' directly in Node's require cache before (re-)requiring
//    './update' each test (same trick sessionManager.test.js uses for
//    './claude').
const cp = require('child_process');
cp.spawn = vi.fn();
const spawn = cp.spawn;

const GIT_PATH = require.resolve('./git');
const UPDATE_PATH = require.resolve('./update');

// Build a fake child_process-shaped EventEmitter for a mocked spawn() call,
// then asynchronously fire 'close' with the given exit code (and optionally
// emit some stdout first) — mirrors how runCmd()'s listeners are wired.
function fakeChild(code) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  setTimeout(() => {
    child.stdout.emit('data', Buffer.from('ok\n'));
    child.emit('close', code);
  }, 0);
  return child;
}

describe('runUpdate', () => {
  let existsSyncSpy;
  let log;
  let runGit;
  let runUpdate;

  beforeEach(() => {
    log = [];
    spawn.mockReset();
    existsSyncSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true); // .git present by default

    runGit = vi.fn();
    require.cache[GIT_PATH] = { id: GIT_PATH, filename: GIT_PATH, loaded: true, exports: { runGit } };
    delete require.cache[UPDATE_PATH];
    ({ runUpdate } = require('./update'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete require.cache[GIT_PATH];
    delete require.cache[UPDATE_PATH];
  });

  function onData(d) { log.push(d); }

  it('refuses to update when the app folder is not a git repo', async () => {
    existsSyncSpy.mockReturnValue(false);
    const result = await runUpdate(onData);
    expect(result.ok).toBe(false);
    expect(result.shouldRestart).toBeUndefined();
    expect(runGit).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(log.join('')).toMatch(/not a git repo/);
  });

  it('stops (no install/build) when `git pull` fails', async () => {
    runGit.mockResolvedValue({ code: 1 });
    const result = await runUpdate(onData);
    expect(result.ok).toBe(false);
    expect(result.shouldRestart).toBeUndefined();
    expect(runGit).toHaveBeenCalledWith(['pull', '--ff-only'], expect.any(String), onData);
    expect(spawn).not.toHaveBeenCalled();
    expect(log.join('')).toMatch(/Pull failed/);
  });

  it('stops (no build) when `npm install` fails', async () => {
    runGit.mockResolvedValue({ code: 0 });
    spawn.mockImplementationOnce(() => fakeChild(1)); // npm install fails
    const result = await runUpdate(onData);
    expect(result.ok).toBe(false);
    expect(result.shouldRestart).toBeUndefined();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][0]).toBe('npm');
    expect(spawn.mock.calls[0][1]).toEqual(['install']);
    expect(log.join('')).toMatch(/npm install failed/);
  });

  it('does not restart when `npm run build` fails', async () => {
    runGit.mockResolvedValue({ code: 0 });
    spawn
      .mockImplementationOnce(() => fakeChild(0)) // npm install succeeds
      .mockImplementationOnce(() => fakeChild(1)); // npm run build fails
    const result = await runUpdate(onData);
    expect(result.ok).toBe(false);
    expect(result.shouldRestart).toBeUndefined();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[1][1]).toEqual(['run', 'build']);
    expect(log.join('')).toMatch(/build failed/);
  });

  it('reports ok + shouldRestart only on full success', async () => {
    runGit.mockResolvedValue({ code: 0 });
    spawn
      .mockImplementationOnce(() => fakeChild(0)) // npm install
      .mockImplementationOnce(() => fakeChild(0)); // npm run build
    const result = await runUpdate(onData);
    expect(result).toEqual({ ok: true, message: 'Update complete', shouldRestart: true });
    expect(runGit).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(2);
  });
});
