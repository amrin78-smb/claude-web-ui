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

      const made = backup.createBackup(dest, { appRoot });
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
      expect(backup.createBackup(dest, { appRoot }).ok).toBe(true);

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
      backup.createBackup(dest, { appRoot });

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
      backup.createBackup(dest, { appRoot });

      // Existing conversation on the target machine.
      write(path.join(fakeHome, '.claude', 'projects', slugA, 'conv.jsonl'), 'PRECIOUS\n');

      const back = await backup.restoreBackup(dest, { appRoot });
      expect(back.ok).toBe(true);
      expect(fs.readFileSync(path.join(fakeHome, '.claude', 'projects', slugA, 'conv.jsonl'), 'utf8'))
        .toBe('PRECIOUS\n');
      expect(back.log.join(' ')).toMatch(/did not overwrite/);
    });

    it('refuses to write into a non-empty destination', () => {
      seedSource();
      const dest = path.join(tmpRoot, 'backup');
      write(path.join(dest, 'something.txt'), 'x');
      const made = backup.createBackup(dest, { appRoot });
      expect(made.ok).toBe(false);
      expect(made.message).toMatch(/not empty/);
    });

    it('can skip transcripts, and reports the size up front', () => {
      seedSource();
      const plan = backup.planBackup({ appRoot });
      expect(plan.sessionCount).toBe(2);
      expect(plan.totalBytes).toBeGreaterThan(0);

      const dest = path.join(tmpRoot, 'backup-light');
      const made = backup.createBackup(dest, { appRoot, includeTranscripts: false });
      expect(made.ok).toBe(true);
      expect(fs.existsSync(path.join(dest, 'projects'))).toBe(false);
      expect(fs.existsSync(path.join(dest, 'app', 'sessions.json'))).toBe(true);
    });

    it('dryRun reports what would happen without writing', async () => {
      seedSource();
      const dest = path.join(tmpRoot, 'backup');
      backup.createBackup(dest, { appRoot });
      const before = fs.readFileSync(path.join(appRoot, 'sessions.json'), 'utf8');

      const back = await backup.restoreBackup(dest, { appRoot, dryRun: true });
      expect(back.ok).toBe(true);
      expect(back.dryRun).toBe(true);
      expect(fs.readFileSync(path.join(appRoot, 'sessions.json'), 'utf8')).toBe(before);
    });
  });
});
