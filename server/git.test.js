/* Exercises gitDiff()/syncRepo() against a REAL temp git repo (git is a hard
 * dependency of the sync feature anyway) rather than mocking child_process,
 * so these also catch a wrong git argv, not just wrong JS logic.
 */
// describe/it/expect/beforeEach/afterEach/vi come from Vitest's `globals: true`
// (see vitest.config.ts) — Vitest 4 doesn't allow `require('vitest')`.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { gitDiff, syncRepo } = require('./git');

function run(cmd, cwd) {
  execSync(cmd, { cwd, stdio: 'pipe' });
}

describe('gitDiff', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-web-ui-git-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports isRepo:false for a plain folder', async () => {
    const result = await gitDiff(dir);
    expect(result).toEqual({ ok: true, isRepo: false, files: [], patch: '' });
  });

  it('reports a clean repo with no files', async () => {
    run('git init -q', dir);
    run('git -c user.email=a@b.c -c user.name=t commit -q --allow-empty -m init', dir);
    const result = await gitDiff(dir);
    expect(result.ok).toBe(true);
    expect(result.isRepo).toBe(true);
    expect(result.files).toEqual([]);
  });

  it('lists a modified tracked file with added/removed counts', async () => {
    run('git init -q', dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
    run('git add a.txt', dir);
    run('git -c user.email=a@b.c -c user.name=t commit -q -m init', dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');

    const result = await gitDiff(dir);
    expect(result.isRepo).toBe(true);
    expect(result.files).toEqual([{ path: 'a.txt', status: 'M', added: 1, removed: 0 }]);
    expect(result.patch).toContain('+three');
  });

  it('lists an untracked file (which diff --numstat alone would miss)', async () => {
    run('git init -q', dir);
    run('git -c user.email=a@b.c -c user.name=t commit -q --allow-empty -m init', dir);
    fs.writeFileSync(path.join(dir, 'new.txt'), 'hello\n');

    const result = await gitDiff(dir);
    expect(result.files).toEqual([{ path: 'new.txt', status: '??', added: 0, removed: 0 }]);
  });
});

describe('syncRepo', () => {
  afterEach(() => vi.restoreAllMocks());

  it('refuses to run with no repo configured', async () => {
    const log = [];
    const result = await syncRepo('C:\\wherever', d => log.push(d), { repoUrl: '' });
    expect(result.ok).toBe(false);
    expect(log.join('')).toMatch(/No GitHub repo configured/);
  });

  it('refuses to clone into a non-empty folder that is not already a repo', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-web-ui-git-test-'));
    fs.writeFileSync(path.join(dir, 'existing.txt'), 'x');
    try {
      const log = [];
      const result = await syncRepo(dir, d => log.push(d), { repoUrl: 'https://example.com/repo.git' });
      expect(result.ok).toBe(false);
      expect(result.message).toBe('folder not empty');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
