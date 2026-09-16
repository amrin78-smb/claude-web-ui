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
  const realPlatform = process.platform;

  afterEach(() => {
    vi.restoreAllMocks();
    // Object.defineProperty() isn't undone by restoreAllMocks(), so put the
    // real platform back by hand — otherwise 'win32' leaks into later tests.
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  });

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
    // The branch under test is `parent === abs`: a path that is its own parent,
    // i.e. a filesystem root. listDir() uses the ambient `path` module, so that
    // string is 'C:\' on Windows but '/' on Linux — overriding process.platform
    // cannot change it, and a hard-coded 'C:\' just resolves against cwd and
    // ENOENTs on the Linux CI runner. Derive the real root instead, and stub
    // readdirSync so this never scans an actual drive root.
    const root = path.parse(process.cwd()).root;
    vi.spyOn(fs, 'readdirSync').mockReturnValue([]);
    const result = listDir(root, root);
    expect(result.parent).toBe('__drives__');
  });
});
