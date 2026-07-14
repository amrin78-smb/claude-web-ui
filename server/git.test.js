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
const { gitDiff, syncRepo, syncAllRepos } = require('./git');

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

describe('syncAllRepos', () => {
  let workDir;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-web-ui-git-test-work-'));
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  // Git accepts a local filesystem path as a clone URL, so a plain repo on
  // disk stands in for "GitHub" here — no network dependency in tests.
  function makeSourceRepo() {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-web-ui-git-test-src-'));
    run('git init -q -b main', src);
    fs.writeFileSync(path.join(src, 'a.txt'), 'one\n');
    run('git add a.txt', src);
    run('git -c user.email=a@b.c -c user.name=t commit -q -m init', src);
    return src;
  }

  it('refuses with no workspace folder configured', async () => {
    const log = [];
    const result = await syncAllRepos('', [{ name: 'x', url: 'https://example.com/x.git' }], d => log.push(d));
    expect(result.ok).toBe(false);
    expect(result.message).toBe('no workspace folder configured');
  });

  it('refuses with no repos configured', async () => {
    const log = [];
    const result = await syncAllRepos(workDir, [], d => log.push(d));
    expect(result.ok).toBe(false);
    expect(result.message).toBe('no repos configured');
  });

  it('clones a repo that does not exist yet', async () => {
    const src = makeSourceRepo();
    try {
      const log = [];
      const result = await syncAllRepos(workDir, [{ name: 'proj', url: src }], d => log.push(d));
      expect(result.ok).toBe(true);
      expect(fs.existsSync(path.join(workDir, 'proj', 'a.txt'))).toBe(true);
      expect(log.join('')).toMatch(/cloning/);
    } finally {
      fs.rmSync(src, { recursive: true, force: true });
    }
  });

  it('pulls an already-cloned repo instead of re-cloning', async () => {
    const src = makeSourceRepo();
    try {
      await syncAllRepos(workDir, [{ name: 'proj', url: src }], () => {});

      // New commit upstream, then sync again — should fast-forward, not re-clone.
      fs.writeFileSync(path.join(src, 'b.txt'), 'two\n');
      run('git add b.txt', src);
      run('git -c user.email=a@b.c -c user.name=t commit -q -m second', src);

      const log = [];
      const result = await syncAllRepos(workDir, [{ name: 'proj', url: src }], d => log.push(d));
      expect(result.ok).toBe(true);
      expect(fs.existsSync(path.join(workDir, 'proj', 'b.txt'))).toBe(true);
      expect(log.join('')).toMatch(/pulling latest/);
    } finally {
      fs.rmSync(src, { recursive: true, force: true });
    }
  });

  it('skips a repo whose destination folder is non-empty and not a git repo, but keeps going', async () => {
    const src = makeSourceRepo();
    try {
      fs.mkdirSync(path.join(workDir, 'blocked'));
      fs.writeFileSync(path.join(workDir, 'blocked', 'existing.txt'), 'x');

      const log = [];
      const result = await syncAllRepos(
        workDir,
        [{ name: 'blocked', url: src }, { name: 'proj', url: src }],
        d => log.push(d)
      );
      expect(result.ok).toBe(false);
      expect(result.message).toBe('some repos failed');
      expect(fs.existsSync(path.join(workDir, 'proj', 'a.txt'))).toBe(true); // 2nd repo still synced
    } finally {
      fs.rmSync(src, { recursive: true, force: true });
    }
  });
});
