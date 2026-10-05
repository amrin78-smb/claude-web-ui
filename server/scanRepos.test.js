/* Scanning a folder for checkouts, to fill in the workspace repo list.
 *
 * The list is a *provisioning* list — clone these, pull these — so the only
 * fields that matter are name, url and branch. A checkout with no origin is
 * useless for that but must still be reported rather than silently dropped,
 * otherwise the count in the message disagrees with the rows on screen and the
 * user is left wondering which of their folders was ignored and why.
 *
 * describe/it/expect come from Vitest's `globals: true` (see vitest.config.ts).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { scanRepos } = require('./git');

const git = (args, cwd) => execFileSync('git', args, { cwd, stdio: 'pipe' });

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cwui-scan-')); });
afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

function makeRepo(name, remote) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main'], dir);
  if (remote) git(['remote', 'add', 'origin', remote], dir);
  return dir;
}

describe('scanRepos', () => {
  it('finds the checkouts directly inside a folder', async () => {
    makeRepo('alpha', 'https://example.com/alpha.git');
    makeRepo('beta', 'https://example.com/beta.git');
    fs.mkdirSync(path.join(root, 'not-a-repo'));

    const r = await scanRepos(root);
    expect(r.ok).toBe(true);
    expect(r.repos.map((x) => x.name)).toEqual(['alpha', 'beta']);
    expect(r.repos[0].url).toBe('https://example.com/alpha.git');
    expect(r.repos[0].branch).toBe('main');
  });

  it('sorts by name, so the list does not shuffle between scans', async () => {
    makeRepo('zulu', 'https://example.com/z.git');
    makeRepo('alpha', 'https://example.com/a.git');
    const r = await scanRepos(root);
    expect(r.repos.map((x) => x.name)).toEqual(['alpha', 'zulu']);
  });

  it('flags a checkout with no origin rather than hiding it', async () => {
    makeRepo('orphan', null);
    const r = await scanRepos(root);
    expect(r.repos).toHaveLength(1);
    expect(r.repos[0].noRemote).toBe(true);
    expect(r.repos[0].url).toBe('');
    // ...and the message says so, so the count matches what is on screen.
    expect(r.message).toMatch(/no remote/);
  });

  it('does not descend past the first level', async () => {
    // A workspace root holds a project per subfolder. Recursing would wander
    // into node_modules and vendored checkouts.
    const outer = makeRepo('outer', 'https://example.com/outer.git');
    const inner = path.join(outer, 'vendor', 'inner');
    fs.mkdirSync(inner, { recursive: true });
    git(['init', '-q'], inner);

    const r = await scanRepos(root);
    expect(r.repos.map((x) => x.name)).toEqual(['outer']);
  });

  it('an empty folder is a result, not a failure', async () => {
    const r = await scanRepos(root);
    expect(r.ok).toBe(true);
    expect(r.repos).toEqual([]);
    expect(r.message).toMatch(/No git checkouts/);
  });

  it('a missing folder fails with the path in the message', async () => {
    const missing = path.join(root, 'nope');
    const r = await scanRepos(missing);
    expect(r.ok).toBe(false);
    expect(r.repos).toEqual([]);
    expect(r.message).toContain(missing);
  });

  it('no folder at all is a failure, not a crash', async () => {
    const r = await scanRepos('');
    expect(r.ok).toBe(false);
    expect(r.repos).toEqual([]);
  });

  it('counts only the usable repos in its message', async () => {
    makeRepo('good', 'https://example.com/good.git');
    makeRepo('orphan', null);
    const r = await scanRepos(root);
    expect(r.repos).toHaveLength(2);
    expect(r.message).toMatch(/Found 1 repo\b/);
    expect(r.message).toMatch(/1 with no remote/);
  });
});
