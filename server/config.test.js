/* config.js reads/writes config.json in the repo root via fs — spy on fs so
 * tests never touch the real (gitignored, machine-specific) config.json.
 */
// describe/it/expect/vi/afterEach come from Vitest's `globals: true`
// (see vitest.config.ts) — Vitest 4 doesn't allow `require('vitest')`.
const fs = require('fs');
const { loadConfig, saveConfig } = require('./config');

describe('loadConfig', () => {
  afterEach(() => vi.restoreAllMocks());

  it('normalizes a fully-populated file as-is', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({
      repoUrl: 'https://example.com/repo.git',
      branch: 'main',
      autoSync: true,
      cwd: 'C:\\work',
      recents: ['C:\\a', 'C:\\b'],
      pinned: ['C:\\a'],
      syncWorkDir: 'C:\\NocVault',
      syncRepos: [{ name: 'x', url: 'https://example.com/x.git' }],
    }));
    expect(loadConfig()).toEqual({
      repoUrl: 'https://example.com/repo.git',
      branch: 'main',
      autoSync: true,
      cwd: 'C:\\work',
      recents: ['C:\\a', 'C:\\b'],
      pinned: ['C:\\a'],
      syncWorkDir: 'C:\\NocVault',
      syncRepos: [{ name: 'x', url: 'https://example.com/x.git' }],
    });
  });

  it('fills in defaults for missing fields', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({ repoUrl: 'x' }));
    expect(loadConfig()).toEqual({
      repoUrl: 'x', branch: '', autoSync: false, cwd: '', recents: [], pinned: [],
      syncWorkDir: '', syncRepos: [],
    });
  });

  it('coerces non-array recents/pinned/syncRepos to []', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({ recents: 'oops', pinned: null, syncRepos: 'oops' })
    );
    const cfg = loadConfig();
    expect(cfg.recents).toEqual([]);
    expect(cfg.pinned).toEqual([]);
    expect(cfg.syncRepos).toEqual([]);
  });

  it('returns all defaults when the file is missing or unreadable', () => {
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw new Error('ENOENT'); });
    expect(loadConfig()).toEqual({
      repoUrl: '', branch: '', autoSync: false, cwd: '', recents: [], pinned: [],
      syncWorkDir: '', syncRepos: [],
    });
  });

  it('returns all defaults when the file has invalid JSON', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue('{not json');
    expect(loadConfig()).toEqual({
      repoUrl: '', branch: '', autoSync: false, cwd: '', recents: [], pinned: [],
      syncWorkDir: '', syncRepos: [],
    });
  });
});

describe('saveConfig', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes pretty-printed JSON to CONFIG_PATH', () => {
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    const cfg = {
      repoUrl: 'x', branch: '', autoSync: false, cwd: '', recents: [], pinned: [],
      syncWorkDir: '', syncRepos: [],
    };
    saveConfig(cfg);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const [, written] = writeSpy.mock.calls[0];
    expect(JSON.parse(written)).toEqual(cfg);
  });

  it('swallows write errors instead of throwing', () => {
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => { throw new Error('EACCES'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => saveConfig({})).not.toThrow();
  });
});
