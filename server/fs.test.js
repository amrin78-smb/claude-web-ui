// describe/it/expect/vi/afterEach/beforeEach come from Vitest's `globals: true`
// (see vitest.config.ts) — Vitest 4 doesn't allow `require('vitest')`.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { listDir } = require('./fs');

describe('listDir — subfolder listing', () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-web-ui-fs-test-'));
    fs.mkdirSync(path.join(root, 'zeta'));
    fs.mkdirSync(path.join(root, 'alpha'));
    fs.mkdirSync(path.join(root, '$RECYCLE.BIN'));
    fs.writeFileSync(path.join(root, 'not-a-dir.txt'), 'hi');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('lists only subdirectories, sorted, hiding $-prefixed system junk', () => {
    const result = listDir(root, root);
    expect(result.path).toBe(path.resolve(root));
    expect(result.dirs.map(d => d.name)).toEqual(['alpha', 'zeta']);
    expect(result.dirs[0].path).toBe(path.join(path.resolve(root), 'alpha'));
  });

  it('falls back to currentCwd when target is falsy', () => {
    const result = listDir(null, root);
    expect(result.path).toBe(path.resolve(root));
  });

  it('sets parent to the resolved parent directory', () => {
    const child = path.join(root, 'alpha');
    const result = listDir(child, root);
    expect(result.parent).toBe(path.resolve(root));
  });
});

describe('listDir — __drives__', () => {
  afterEach(() => vi.restoreAllMocks());

  it('enumerates only existing drive letters on win32', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => p === 'C:\\' || p === 'D:\\');
    const result = listDir('__drives__', 'C:\\');
    expect(result.parent).toBeNull();
    expect(result.dirs).toEqual([
      { name: 'C:\\', path: 'C:\\' },
      { name: 'D:\\', path: 'D:\\' },
    ]);
  });

  it('the root of a drive reports its parent as __drives__', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const result = listDir('C:\\', 'C:\\');
    expect(result.parent).toBe('__drives__');
  });
});
