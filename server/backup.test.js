/* backup.js moves app state AND the Claude CLI's transcripts between machines.
 * The risky part is the path remapping — a wrong rewrite silently orphans a
 * conversation (the file is there, Claude just never looks in that slug). These
 * tests drive a real backup -> restore round trip against temp directories,
 * including a Windows -> POSIX move, rather than asserting on mocks.
 *
 * describe/it/expect/vi come from Vitest's `globals: true` (see vitest.config.ts).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE_PATH = require.resolve('./claude');
const BACKUP_PATH = require.resolve('./backup');

let tmpRoot, fakeHome, appRoot, backup;

// backup.js resolves APP_ROOT and the Claude home at require time, so both have
// to be redirected before the first require — same require.cache stubbing the
// sessionManager tests use.
function loadBackupWith(homeDir) {
  require.cache[CLAUDE_PATH] = {
    id: CLAUDE_PATH, filename: CLAUDE_PATH, loaded: true,
    exports: {
      claudeProjectDir: (cwd) =>
        path.join(homeDir, '.claude', 'projects', String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-')),
    },
  };
  delete require.cache[BACKUP_PATH];
  return require('./backup');
}

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
}

describe('backup', () => {
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwui-backup-'));
    fakeHome = path.join(tmpRoot, 'home');
    appRoot = path.join(tmpRoot, 'app');
    fs.mkdirSync(appRoot, { recursive: true });
    backup = loadBackupWith(fakeHome);
  });

  afterEach(() => {
    delete require.cache[CLAUDE_PATH];
    delete require.cache[BACKUP_PATH];
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  describe('remapPath', () => {
    const rules = [{ from: 'C:\\Users\\me\\proj', to: '/home/me/proj' }];

    it('rewrites a path under the mapped root and converts separators', () => {
      expect(backup.remapPath('C:\\Users\\me\\proj\\app\\src', rules)).toBe('/home/me/proj/app/src');
    });

    it('rewrites the root itself', () => {
      expect(backup.remapPath('C:\\Users\\me\\proj', rules)).toBe('/home/me/proj');
    });

    it('leaves paths outside the mapped root alone', () => {
      expect(backup.remapPath('D:\\other\\thing', rules)).toBe('D:\\other\\thing');
    });

    it('does not match a sibling folder with the same prefix', () => {
      // …\projX must not be treated as living inside …\proj
      expect(backup.remapPath('C:\\Users\\me\\projX\\a', rules)).toBe('C:\\Users\\me\\projX\\a');
    });

    it('matches case-insensitively, as Windows does', () => {
      expect(backup.remapPath('c:\\users\\ME\\Proj\\x', rules)).toBe('/home/me/proj/x');
    });

    it('prefers the most specific root when roots are nested', () => {
      const nested = backup.normalizeRules({
        'C:\\a': '/one',
        'C:\\a\\b': '/two',
      });
      expect(backup.remapPath('C:\\a\\b\\c', nested)).toBe('/two/c');
      expect(backup.remapPath('C:\\a\\z', nested)).toBe('/one/z');
    });
  });

  describe('round trip', () => {
    // Build a machine: two project folders, app state pointing at them, and a
    // transcript for one of them.
    function seedSource() {
      const projA = path.join(tmpRoot, 'src', 'alpha');
      const projB = path.join(tmpRoot, 'src', 'beta');
      fs.mkdirSync(projA, { recursive: true });
      fs.mkdirSync(projB, { recursive: true });

      write(path.join(appRoot, 'sessions.json'), [
        { id: 's1', cwd: projA, title: 'alpha' },
        { id: 's2', cwd: projB, title: 'beta' },
      ]);
      write(path.join(appRoot, 'config.json'), {
        recents: [projA, projB], pinned: [], syncWorkDir: path.join(tmpRoot, 'src'),
      });

      const slugA = backup.projectSlug(projA);
      const transcript = path.join(fakeHome, '.claude', 'projects', slugA, 'conv.jsonl');
      write(transcript, [
        JSON.stringify({ type: 'user', cwd: projA, message: 'hi' }),
        JSON.stringify({ type: 'assistant', cwd: projA, trackingPath: path.join(projA, 'f.txt') }),
        'not json at all',
        JSON.stringify({ type: 'meta' }),
      ].join('\n') + '\n');

      return { projA, projB, slugA, transcript };
    }

    it('backs up app state and transcripts, then restores them in place', async () => {
      const { projA, slugA } = seedSource();
      const dest = path.join(tmpRoot, 'backup');

      const made = await backup.createBackup(dest, { appRoot });
      expect(made.ok).toBe(true);
      expect(fs.existsSync(path.join(dest, 'manifest.json'))).toBe(true);
      expect(fs.existsSync(path.join(dest, 'app', 'sessions.json'))).toBe(true);
      expect(fs.existsSync(path.join(dest, 'projects', slugA, 'conv.jsonl'))).toBe(true);

      // Wipe the live state, then restore over the top.
      fs.rmSync(path.join(appRoot, 'sessions.json'));
      fs.rmSync(path.join(fakeHome, '.claude', 'projects', slugA), { recursive: true });

      const back = await backup.restoreBackup(dest, { appRoot });
      expect(back.ok).toBe(true);

      const restored = JSON.parse(fs.readFileSync(path.join(appRoot, 'sessions.json'), 'utf8'));
      expect(restored.map((s) => s.cwd)).toContain(projA);
      expect(fs.existsSync(path.join(fakeHome, '.claude', 'projects', slugA, 'conv.jsonl'))).toBe(true);
    });

    it('remaps paths, slugs and transcript cwd when the folder moves', async () => {
      const { projA, slugA } = seedSource();
      const dest = path.join(tmpRoot, 'backup');
      expect((await backup.createBackup(dest, { appRoot })).ok).toBe(true);

      // The "new machine": same projects at a different root, which must exist
      // or the session is skipped as unreachable.
      const newRoot = path.join(tmpRoot, 'moved');
      const newA = path.join(newRoot, 'alpha');
      fs.mkdirSync(newA, { recursive: true });
      fs.mkdirSync(path.join(newRoot, 'beta'), { recursive: true });
      fs.rmSync(path.join(fakeHome, '.claude', 'projects', slugA), { recursive: true });

      const back = await backup.restoreBackup(dest, {
        appRoot,
        remap: { [path.join(tmpRoot, 'src')]: newRoot },
      });
      expect(back.ok).toBe(true);

      // Sessions and config now point at the new root.
      const sessions = JSON.parse(fs.readFileSync(path.join(appRoot, 'sessions.json'), 'utf8'));
      expect(sessions.map((s) => s.cwd).sort()).toEqual([newA, path.join(newRoot, 'beta')].sort());
      const config = JSON.parse(fs.readFileSync(path.join(appRoot, 'config.json'), 'utf8'));
      expect(config.recents).toContain(newA);

      // The transcript landed under the NEW slug — this is the bit that decides
      // whether Claude can still find the conversation.
      const newSlug = backup.projectSlug(newA);
      expect(newSlug).not.toBe(slugA);
      const moved = path.join(fakeHome, '.claude', 'projects', newSlug, 'conv.jsonl');
      expect(fs.existsSync(moved)).toBe(true);

      const lines = fs.readFileSync(moved, 'utf8').split('\n').filter((l) => l.trim());
      const recs = lines.map((l) => { try { return JSON.parse(l); } catch { return l; } });

      // cwd rewritten...
      expect(recs[0].cwd).toBe(newA);
      expect(recs[1].cwd).toBe(newA);
      // ...historical trackingPath left exactly as it was...
      expect(recs[1].trackingPath).toBe(path.join(projA, 'f.txt'));
      // ...the unparseable line preserved rather than dropped...
      expect(recs[2]).toBe('not json at all');
      // ...and a record with no cwd untouched.
      expect(recs[3]).toEqual({ type: 'meta' });
    });

    it('skips sessions whose folder does not exist on this machine', async () => {
      seedSource();
      const dest = path.join(tmpRoot, 'backup');
      await backup.createBackup(dest, { appRoot });

      const back = await backup.restoreBackup(dest, {
        appRoot,
        remap: { [path.join(tmpRoot, 'src')]: path.join(tmpRoot, 'nowhere') },
      });
      expect(back.ok).toBe(true);
      const sessions = JSON.parse(fs.readFileSync(path.join(appRoot, 'sessions.json'), 'utf8'));
      expect(sessions).toEqual([]);
      expect(back.message).toMatch(/skipped 2/);
    });

    it('never overwrites history that already exists on the target', async () => {
      const { projA, slugA } = seedSource();
      const dest = path.join(tmpRoot, 'backup');
      await backup.createBackup(dest, { appRoot });

      // Existing conversation on the target machine.
      write(path.join(fakeHome, '.claude', 'projects', slugA, 'conv.jsonl'), 'PRECIOUS\n');

      const back = await backup.restoreBackup(dest, { appRoot });
      expect(back.ok).toBe(true);
      expect(fs.readFileSync(path.join(fakeHome, '.claude', 'projects', slugA, 'conv.jsonl'), 'utf8'))
        .toBe('PRECIOUS\n');
      expect(back.log.join(' ')).toMatch(/did not overwrite/);
    });

    it('refuses to write into a non-empty destination', async () => {
      seedSource();
      const dest = path.join(tmpRoot, 'backup');
      write(path.join(dest, 'something.txt'), 'x');
      const made = await backup.createBackup(dest, { appRoot });
      expect(made.ok).toBe(false);
      expect(made.message).toMatch(/not empty/);
    });

    it('can skip transcripts, and reports the size up front', async () => {
      seedSource();
      const plan = await backup.planBackup({ appRoot });
      expect(plan.sessionCount).toBe(2);
      expect(plan.totalBytes).toBeGreaterThan(0);

      const dest = path.join(tmpRoot, 'backup-light');
      const made = await backup.createBackup(dest, { appRoot, includeTranscripts: false });
      expect(made.ok).toBe(true);
      expect(fs.existsSync(path.join(dest, 'projects'))).toBe(false);
      expect(fs.existsSync(path.join(dest, 'app', 'sessions.json'))).toBe(true);
    });

    it('dryRun reports what would happen without writing', async () => {
      seedSource();
      const dest = path.join(tmpRoot, 'backup');
      await backup.createBackup(dest, { appRoot });
      const before = fs.readFileSync(path.join(appRoot, 'sessions.json'), 'utf8');

      const back = await backup.restoreBackup(dest, { appRoot, dryRun: true });
      expect(back.ok).toBe(true);
      expect(back.dryRun).toBe(true);
      expect(fs.readFileSync(path.join(appRoot, 'sessions.json'), 'utf8')).toBe(before);
    });
  });

  // commonRoot is what lets a restore ask for ONE folder instead of an old->new
  // pair, so it has to hold for Windows strings on a POSIX host and vice versa.
  describe('commonRoot', () => {
    it('finds the deepest shared folder', () => {
      expect(backup.commonRoot([
        'C:\\Users\\me\\Documents',
        'C:\\Users\\me\\Documents\\proj\\a',
        'C:\\Users\\me\\Documents\\proj\\b',
      ])).toBe('C:\\Users\\me\\Documents');
    });

    it('ignores case differences but keeps the first spelling', () => {
      expect(backup.commonRoot([
        'C:\\Users\\me\\NocVault\\a',
        'C:\\Users\\me\\nocvault\\b',
      ])).toBe('C:\\Users\\me\\NocVault');
    });

    it('handles POSIX paths', () => {
      expect(backup.commonRoot(['/home/me/a', '/home/me/b/c'])).toBe('/home/me');
    });

    it('keeps a bare drive usable as a root', () => {
      expect(backup.commonRoot(['C:\\a', 'C:\\b'])).toBe('C:\\');
    });

    it('is empty when there is nothing in common', () => {
      expect(backup.commonRoot(['C:\\a', 'D:\\b'])).toBe('');
      expect(backup.commonRoot([])).toBe('');
    });
  });

  // The workDir flow: one folder in, and the restore provisions every project
  // folder itself. cloneOrPull is injected so no network or real git is needed.
  describe('workDir restore', () => {
    function seedTwoProjects() {
      const projA = path.join(tmpRoot, 'src', 'alpha');
      const projB = path.join(tmpRoot, 'src', 'beta');
      fs.mkdirSync(projA, { recursive: true });
      fs.mkdirSync(projB, { recursive: true });
      write(path.join(appRoot, 'sessions.json'), [
        { id: 's1', cwd: projA, title: 'alpha' },
        { id: 's2', cwd: projB, title: 'beta' },
      ]);
      const slugA = backup.projectSlug(projA);
      write(path.join(fakeHome, '.claude', 'projects', slugA, 'conv.jsonl'),
        JSON.stringify({ type: 'user', cwd: projA }) + '\n');
      // alpha is a repo, beta is a plain folder — the two cases a restore has
      // to handle differently (clone vs mkdir).
      const gitInfo = (cwd) => cwd === projA
        ? { isRepo: true, url: 'https://example.test/alpha.git', branch: 'main', dirty: 0, unpushed: 0 }
        : { isRepo: false, url: '', branch: '', dirty: 0, unpushed: 0 };
      return { projA, projB, slugA, gitInfo };
    }

    it('records each project\'s remote and the shared root in the manifest', async () => {
      const { gitInfo } = seedTwoProjects();
      const dest = path.join(tmpRoot, 'backup');
      const made = await backup.createBackup(dest, { appRoot, gitInfo });
      expect(made.ok).toBe(true);

      const m = JSON.parse(fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8'));
      expect(m.version).toBe(2);
      expect(m.commonRoot).toBe(path.join(tmpRoot, 'src'));
      const byTitle = Object.fromEntries(m.projects.map((p) => [p.title, p]));
      expect(byTitle.alpha.repo).toEqual({ url: 'https://example.test/alpha.git', branch: 'main' });
      expect(byTitle.beta.repo).toBeNull();
    });

    it('clones repos, creates plain folders, and remaps everything to the new root', async () => {
      const { projA, gitInfo } = seedTwoProjects();
      const dest = path.join(tmpRoot, 'backup');
      await backup.createBackup(dest, { appRoot, gitInfo });

      const workDir = path.join(tmpRoot, 'newmachine');
      const cloned = [];
      const back = await backup.restoreBackup(dest, {
        appRoot,
        workDir,
        // Stand in for git: create the folder, like a real clone would.
        cloneOrPull: async (destDir, repo) => {
          cloned.push({ destDir, url: repo.url, branch: repo.branch });
          fs.mkdirSync(destDir, { recursive: true });
          return { ok: true, message: 'cloned' };
        },
      });

      expect(back.ok).toBe(true);
      expect(cloned).toEqual([{
        destDir: path.join(workDir, 'alpha'),
        url: 'https://example.test/alpha.git',
        branch: 'main',
      }]);

      // Sessions point at the new root, and none were dropped.
      const restored = JSON.parse(fs.readFileSync(path.join(appRoot, 'sessions.json'), 'utf8'));
      expect(restored.map((s) => s.cwd).sort()).toEqual(
        [path.join(workDir, 'alpha'), path.join(workDir, 'beta')].sort()
      );
      // The plain folder was created even though nothing cloned it.
      expect(fs.existsSync(path.join(workDir, 'beta'))).toBe(true);

      // History is filed under the NEW slug, with cwd rewritten inside.
      const newSlug = backup.projectSlug(path.join(workDir, 'alpha'));
      const conv = path.join(fakeHome, '.claude', 'projects', newSlug, 'conv.jsonl');
      expect(fs.existsSync(conv)).toBe(true);
      const rec = JSON.parse(fs.readFileSync(conv, 'utf8').trim());
      expect(rec.cwd).toBe(path.join(workDir, 'alpha'));
      expect(rec.cwd).not.toBe(projA);
    });

    it('counts folders it is about to create as present, so the preview is not all skips', async () => {
      const { gitInfo } = seedTwoProjects();
      const dest = path.join(tmpRoot, 'backup');
      await backup.createBackup(dest, { appRoot, gitInfo });

      const back = await backup.restoreBackup(dest, {
        appRoot, workDir: path.join(tmpRoot, 'nowhere-yet'), dryRun: true,
      });
      expect(back.ok).toBe(true);
      expect(back.sessions).toHaveLength(2);
      expect(back.message).toContain('0 skipped');
      expect(back.log.join('\n')).toContain('would clone https://example.test/alpha.git');
    });

    it('reports a failed clone instead of pretending it worked', async () => {
      const { gitInfo } = seedTwoProjects();
      const dest = path.join(tmpRoot, 'backup');
      await backup.createBackup(dest, { appRoot, gitInfo });

      const back = await backup.restoreBackup(dest, {
        appRoot,
        workDir: path.join(tmpRoot, 'newmachine'),
        cloneOrPull: async () => ({ ok: false, message: 'clone failed' }),
      });
      expect(back.provisionFailed).toBe(1);
      expect(back.log.join('\n')).toContain('FAILED — clone failed');
      // alpha never got created, so its session is dropped rather than left
      // pointing at a folder that isn't there.
      const restored = JSON.parse(fs.readFileSync(path.join(appRoot, 'sessions.json'), 'utf8'));
      expect(restored.map((s) => s.title)).toEqual(['beta']);
    });

    it('refuses a workDir restore of a backup that recorded no root', async () => {
      seedTwoProjects();
      const dest = path.join(tmpRoot, 'backup');
      await backup.createBackup(dest, { appRoot });
      // Simulate a v1 backup: supported for reading, but nothing to derive from.
      const mp = path.join(dest, 'manifest.json');
      const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
      delete m.commonRoot;
      m.version = 1;
      fs.writeFileSync(mp, JSON.stringify(m));

      const back = await backup.restoreBackup(dest, { appRoot, workDir: path.join(tmpRoot, 'x') });
      expect(back.ok).toBe(false);
      expect(back.message).toContain('does not record a root folder');
    });

    it('still reads a v1 backup with an explicit remap', async () => {
      const { projA } = seedTwoProjects();
      const dest = path.join(tmpRoot, 'backup');
      await backup.createBackup(dest, { appRoot });
      const mp = path.join(dest, 'manifest.json');
      const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
      m.version = 1;
      fs.writeFileSync(mp, JSON.stringify(m));

      const back = await backup.restoreBackup(dest, { appRoot });
      expect(back.ok).toBe(true);
      const restored = JSON.parse(fs.readFileSync(path.join(appRoot, 'sessions.json'), 'utf8'));
      expect(restored.map((s) => s.cwd)).toContain(projA);
    });
  });

  // A .zip destination is the carry-one-file case. It has to round-trip through
  // a real archive, not a staged copy, and restore has to accept either form.
  describe('zip archive', () => {
    function seedOne() {
      const proj = path.join(tmpRoot, 'src', 'alpha');
      fs.mkdirSync(proj, { recursive: true });
      write(path.join(appRoot, 'sessions.json'), [{ id: 's1', cwd: proj, title: 'alpha' }]);
      write(path.join(appRoot, 'config.json'), { recents: [proj], pinned: [], cwd: proj });
      const slug = backup.projectSlug(proj);
      write(path.join(fakeHome, '.claude', 'projects', slug, 'conv.jsonl'),
        JSON.stringify({ type: 'user', cwd: proj, message: 'hi' }) + '\n');
      return { proj, slug };
    }

    it('detects a .zip destination by extension, case-insensitively', () => {
      expect(backup.isZipPath('a/b.zip')).toBe(true);
      expect(backup.isZipPath('a/b.ZIP')).toBe(true);
      expect(backup.isZipPath('a/b')).toBe(false);
    });

    it('writes a single file instead of a tree', async () => {
      seedOne();
      const dest = path.join(tmpRoot, 'bk.zip');
      const made = await backup.createBackup(dest, { appRoot });
      expect(made.ok).toBe(true);
      expect(made.zipped).toBe(true);
      expect(fs.statSync(dest).isFile()).toBe(true);
      expect(made.bytes).toBeGreaterThan(0);
      // ZIP local file header magic — it's a real archive, not a renamed folder.
      const head = fs.readFileSync(dest).subarray(0, 4);
      expect([...head]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    });

    // Regression: yazl's addFile() stats the file and then throws if the stream
    // delivers a different byte count. Transcripts are appended to by every
    // running session, so a file growing mid-backup is normal — this threw
    // "file data stream has unexpected number of bytes" on real data.
    it('survives a transcript that grows while it is being archived', async () => {
      const proj = path.join(tmpRoot, 'src', 'alpha');
      fs.mkdirSync(proj, { recursive: true });
      write(path.join(appRoot, 'sessions.json'), [{ id: 's1', cwd: proj, title: 'alpha' }]);

      // Big enough that reading it spans several ticks, giving the appends below
      // a chance to land mid-stream.
      const slug = backup.projectSlug(proj);
      const conv = path.join(fakeHome, '.claude', 'projects', slug, 'conv.jsonl');
      const line = JSON.stringify({ type: 'user', cwd: proj, message: 'x'.repeat(400) }) + '\n';
      write(conv, line.repeat(8000));

      const dest = path.join(tmpRoot, 'bk.zip');
      let appends = 0;
      const timer = setInterval(() => { fs.appendFileSync(conv, line); appends++; }, 0);
      let made;
      try {
        made = await backup.createBackup(dest, { appRoot });
      } finally {
        clearInterval(timer);
      }

      expect(appends).toBeGreaterThan(0); // the race actually happened
      expect(made.ok).toBe(true);
      expect(fs.statSync(dest).isFile()).toBe(true);

      // And the archive is still readable end to end.
      const back = await backup.restoreBackup(dest, { appRoot, dryRun: true });
      expect(back.ok).toBe(true);
    });

    it('refuses to overwrite an existing archive', async () => {
      seedOne();
      const dest = path.join(tmpRoot, 'bk.zip');
      fs.writeFileSync(dest, 'already here');
      const made = await backup.createBackup(dest, { appRoot });
      expect(made.ok).toBe(false);
      expect(made.message).toContain('already exists');
      expect(fs.readFileSync(dest, 'utf8')).toBe('already here');
    });

    it('restores straight from the .zip, remapping as usual', async () => {
      const { proj, slug } = seedOne();
      const dest = path.join(tmpRoot, 'bk.zip');
      expect((await backup.createBackup(dest, { appRoot })).ok).toBe(true);

      // Wipe the machine, then move the project somewhere new.
      fs.rmSync(path.join(appRoot, 'sessions.json'));
      fs.rmSync(path.join(fakeHome, '.claude', 'projects', slug), { recursive: true });
      const newRoot = path.join(tmpRoot, 'moved');
      const newA = path.join(newRoot, 'alpha');
      fs.mkdirSync(newA, { recursive: true });

      const back = await backup.restoreBackup(dest, {
        appRoot, remap: { [path.join(tmpRoot, 'src')]: newRoot },
      });
      expect(back.ok).toBe(true);

      const sessions = JSON.parse(fs.readFileSync(path.join(appRoot, 'sessions.json'), 'utf8'));
      expect(sessions.map((s) => s.cwd)).toEqual([newA]);

      const newSlug = backup.projectSlug(newA);
      const conv = path.join(fakeHome, '.claude', 'projects', newSlug, 'conv.jsonl');
      expect(fs.existsSync(conv)).toBe(true);
      expect(JSON.parse(fs.readFileSync(conv, 'utf8').trim()).cwd).toBe(newA);
      expect(JSON.parse(fs.readFileSync(conv, 'utf8').trim()).cwd).not.toBe(proj);
    });

    it('leaves no temp extraction behind', async () => {
      seedOne();
      const dest = path.join(tmpRoot, 'bk.zip');
      await backup.createBackup(dest, { appRoot });
      const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('cwui-restore-'));
      await backup.restoreBackup(dest, { appRoot });
      const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('cwui-restore-'));
      expect(after).toEqual(before);
    });

    it('rejects a file that is not a zip', async () => {
      const notZip = path.join(tmpRoot, 'notes.txt');
      fs.writeFileSync(notZip, 'hello');
      const back = await backup.restoreBackup(notZip, { appRoot });
      expect(back.ok).toBe(false);
      expect(back.message).toContain('not a .zip');
    });

    it('reports a missing source rather than throwing', async () => {
      const back = await backup.restoreBackup(path.join(tmpRoot, 'nope.zip'), { appRoot });
      expect(back.ok).toBe(false);
      expect(back.message).toContain('not found');
    });

    // A backup travels on removable media and its entry names are trivially
    // editable, so they're untrusted input: an entry must not be able to write
    // outside the extraction folder.
    it('refuses archive entries that would escape the extraction folder', () => {
      const root = path.join(tmpRoot, 'out');
      expect(backup.safeEntryPath(root, 'app/config.json')).toBe(path.join(root, 'app', 'config.json'));
      expect(backup.safeEntryPath(root, '../escaped.json')).toBeNull();
      expect(backup.safeEntryPath(root, 'a/../../escaped.json')).toBeNull();
      expect(backup.safeEntryPath(root, '/abs.json')).toBe(path.join(root, 'abs.json'));
      expect(backup.safeEntryPath(root, '')).toBeNull();
    });
  });

  // planBackup surfaces what a clone-based restore would lose. It warns; it
  // never blocks, which is why this asserts on the report rather than an error.
  describe('at-risk reporting', () => {
    it('lists uncommitted and unpushed work per repo', async () => {
      const projA = path.join(tmpRoot, 'src', 'alpha');
      const projB = path.join(tmpRoot, 'src', 'beta');
      fs.mkdirSync(projA, { recursive: true });
      fs.mkdirSync(projB, { recursive: true });
      write(path.join(appRoot, 'sessions.json'), [
        { id: 's1', cwd: projA, title: 'alpha' },
        { id: 's2', cwd: projB, title: 'beta' },
      ]);

      const plan = await backup.planBackup({
        appRoot,
        gitInfo: (cwd) => cwd === projA
          ? { isRepo: true, url: 'u', branch: 'main', dirty: 3, unpushed: 2 }
          : { isRepo: true, url: 'u2', branch: 'main', dirty: 0, unpushed: 0 },
      });

      expect(plan.repoCount).toBe(2);
      expect(plan.plainCount).toBe(0);
      expect(plan.atRisk).toEqual([
        { title: 'alpha', cwd: projA, dirty: 3, unpushed: 2, noUpstream: false },
      ]);
    });

    // Regression: dirSize accumulated into a shared `total += (await stat).size`.
    // That reads `total` before awaiting, so concurrent stats overwrite each
    // other's additions — it reported 435 MB for a real 972 MB, differently each
    // run. The size drives what the UI tells you a backup will cost, so it has to
    // be exact and repeatable.
    it('measures transcript size exactly, and the same way every time', async () => {
      const proj = path.join(tmpRoot, 'src', 'alpha');
      fs.mkdirSync(proj, { recursive: true });
      write(path.join(appRoot, 'sessions.json'), [{ id: 's1', cwd: proj, title: 'alpha' }]);

      // Enough files, nested, that the walk really does run concurrently.
      const slug = backup.projectSlug(proj);
      const base = path.join(fakeHome, '.claude', 'projects', slug);
      let expected = 0;
      for (let d = 0; d < 5; d++) {
        for (let f = 0; f < 20; f++) {
          const size = 100 + d * 20 + f;
          write(path.join(base, 'sub' + d, `f${f}.jsonl`), 'x'.repeat(size));
          expected += size;
        }
      }

      const runs = [];
      for (let i = 0; i < 3; i++) runs.push((await backup.planBackup({ appRoot })).totalBytes);

      expect(runs[0]).toBe(expected);
      expect(new Set(runs).size).toBe(1); // identical every run
    });

    // Regression: gitInfo used to be execFileSync, run one project after another.
    // On 12 projects that was ~2.7s of blocked event loop every time the Backup
    // dialog opened — and this server shares that loop with every session's PTY,
    // so all terminal output froze. Inspection must happen concurrently.
    it('inspects projects concurrently, not one after another', async () => {
      const cwds = [];
      for (let i = 0; i < 8; i++) {
        const p = path.join(tmpRoot, 'src', 'p' + i);
        fs.mkdirSync(p, { recursive: true });
        cwds.push({ id: 's' + i, cwd: p, title: 'p' + i });
      }
      write(path.join(appRoot, 'sessions.json'), cwds);

      const DELAY = 60;
      let inFlight = 0;
      let peak = 0;
      const slowGitInfo = async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, DELAY));
        inFlight--;
        return { isRepo: true, url: 'u', branch: 'main', dirty: 0, unpushed: 0 };
      };

      const t0 = Date.now();
      const plan = await backup.planBackup({ appRoot, gitInfo: slowGitInfo });
      const elapsed = Date.now() - t0;

      expect(plan.projects).toHaveLength(8);
      // Several were in flight at once — not asserting "all 8", so a future
      // concurrency cap stays allowed; what must not come back is one-at-a-time.
      expect(peak).toBeGreaterThan(1);
      // Sequentially this would be 8 * 60 = 480ms.
      expect(elapsed).toBeLessThan(DELAY * 4);
    });

    it('does not flag a clean repo or a plain folder', async () => {
      const proj = path.join(tmpRoot, 'src', 'plain');
      fs.mkdirSync(proj, { recursive: true });
      write(path.join(appRoot, 'sessions.json'), [{ id: 's1', cwd: proj, title: 'plain' }]);

      const plan = await backup.planBackup({
        appRoot,
        gitInfo: () => ({ isRepo: false, url: '', branch: '', dirty: 0, unpushed: 0 }),
      });
      expect(plan.atRisk).toEqual([]);
      expect(plan.plainCount).toBe(1);
    });
  });
});
