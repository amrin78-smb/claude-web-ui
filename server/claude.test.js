/* Regression coverage for findClaude()'s Windows launcher-resolution logic —
 * this is the exact bug that crashed the server with "Cannot create process,
 * error code: 193" (see CLAUDE.md). `where claude` can list an extensionless
 * POSIX shell shim before claude.cmd/.exe; CreateProcess can't execute that
 * shim, so findClaude() must filter to real Windows executables.
 */
// describe/it/expect/vi/beforeEach/afterEach come from Vitest's `globals: true`
// (see vitest.config.ts) — Vitest 4 doesn't allow `require('vitest')`.
const fs = require('fs');
const os = require('os');
const path = require('path');

// vi.mock() intercepts ESM import graphs, not plain CommonJS require() calls
// (this file is CJS) — and claude.js destructures `execSync` out of
// child_process AND calls findClaude() at module-load time. So instead of
// vi.mock(), replace the real child_process.execSync with a vi.fn() before
// './claude' is required the first time, so claude.js's destructured
// reference is the mock, not the real function.
const cp = require('child_process');
cp.execSync = vi.fn();
const { execSync } = cp;
const { findClaude, claudeProjectDir, hasClaudeHistory } = require('./claude');

function setPlatform(value) {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

describe('findClaude', () => {
  let existsSyncSpy;
  let originalPlatform;

  beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    existsSyncSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    execSync.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process, 'platform', originalPlatform);
  });

  it('prefers the npm-global claude.cmd when present', () => {
    setPlatform('win32');
    const npmGlobal = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'claude.cmd');
    existsSyncSpy.mockImplementation((p) => p === npmGlobal);
    expect(findClaude()).toBe(npmGlobal);
    expect(execSync).not.toHaveBeenCalled();
  });

  it('falls back to the curl-installed ~/.local/bin launcher', () => {
    setPlatform('win32');
    const localBin = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
    existsSyncSpy.mockImplementation((p) => p === localBin);
    expect(findClaude()).toBe(localBin);
  });

  it('skips an extensionless POSIX shim from `where` and picks claude.cmd (the bug that crashed the server)', () => {
    setPlatform('win32');
    const shim = 'D:\\scoop\\apps\\nodejs\\current\\bin\\claude';
    const cmd = 'D:\\scoop\\apps\\nodejs\\current\\bin\\claude.cmd';
    execSync.mockReturnValue(`${shim}\r\n${cmd}\r\n`);
    existsSyncSpy.mockImplementation((p) => p === cmd);
    expect(findClaude()).toBe(cmd);
  });

  it('accepts claude.exe when that is the only real-executable match', () => {
    setPlatform('win32');
    const shim = 'D:\\scoop\\apps\\nodejs\\current\\bin\\claude';
    const exe = 'D:\\tools\\claude.exe';
    execSync.mockReturnValue(`${shim}\r\n${exe}\r\n`);
    existsSyncSpy.mockImplementation((p) => p === exe);
    expect(findClaude()).toBe(exe);
  });

  it('falls back to the bare "claude.cmd" name on Windows when nothing resolves', () => {
    setPlatform('win32');
    execSync.mockImplementation(() => { throw new Error('not found'); });
    expect(findClaude()).toBe('claude.cmd');
  });

  it('on non-Windows, accepts the first `which` match verbatim (no extension filtering)', () => {
    setPlatform('linux');
    execSync.mockReturnValue('/usr/local/bin/claude\n');
    existsSyncSpy.mockImplementation((p) => p === '/usr/local/bin/claude');
    expect(findClaude()).toBe('/usr/local/bin/claude');
  });

  it('falls back to the bare "claude" name on non-Windows when nothing resolves', () => {
    setPlatform('linux');
    execSync.mockImplementation(() => { throw new Error('not found'); });
    expect(findClaude()).toBe('claude');
  });
});

describe('claudeProjectDir / hasClaudeHistory', () => {
  afterEach(() => vi.restoreAllMocks());

  it('slugifies the cwd the same way Claude Code does (non-alphanumerics -> "-")', () => {
    const dir = claudeProjectDir('C:\\Users\\me\\app');
    expect(dir).toBe(path.join(os.homedir(), '.claude', 'projects', 'C--Users-me-app'));
  });

  it('returns false when the project dir does not exist', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    expect(hasClaudeHistory('C:\\nowhere')).toBe(false);
  });

  it('returns true only when a .jsonl transcript is present', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readdirSync').mockReturnValue(['notes.txt', 'abc123.jsonl']);
    expect(hasClaudeHistory('C:\\some\\project')).toBe(true);
  });

  it('returns false when the project dir has files but no .jsonl', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readdirSync').mockReturnValue(['notes.txt']);
    expect(hasClaudeHistory('C:\\some\\project')).toBe(false);
  });
});
