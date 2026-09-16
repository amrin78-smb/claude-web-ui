/* The app has two update paths and picks between them from install-mode.json,
 * written by scripts/package.js. Getting this wrong is quietly bad in both
 * directions: a packaged install trying to `git pull` its own Program Files
 * directory, or a dev checkout refusing to update because it thinks it's a
 * package. The absence of the marker must always mean "dev", so every install
 * that predates this feature keeps working.
 *
 * describe/it/expect/vi come from Vitest's `globals: true` (see vitest.config.ts).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { installMode, compareVersions, checkRelease, runUpdate } = require('./update');

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cwui-mode-')); });
afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

function marker(data) {
  fs.writeFileSync(path.join(tmp, 'install-mode.json'), JSON.stringify(data));
}

describe('installMode', () => {
  it('defaults to dev when the marker is absent', () => {
    expect(installMode(tmp).mode).toBe('dev');
  });

  it('defaults to dev when the marker is corrupt', () => {
    fs.writeFileSync(path.join(tmp, 'install-mode.json'), '{ not json');
    expect(installMode(tmp).mode).toBe('dev');
  });

  it('reads a packaged marker, keeping its target and version', () => {
    marker({ mode: 'packaged', target: 'linux-x64', version: '2.0.0' });
    const m = installMode(tmp);
    expect(m.mode).toBe('packaged');
    expect(m.target).toBe('linux-x64');
    expect(m.version).toBe('2.0.0');
  });

  it('treats an unrecognized mode as dev rather than guessing', () => {
    marker({ mode: 'something-else', version: '9.9.9' });
    expect(installMode(tmp).mode).toBe('dev');
  });
});

describe('compareVersions', () => {
  it('orders by numeric component, not string', () => {
    expect(compareVersions('2.10.0', '2.9.0')).toBeGreaterThan(0);
    expect(compareVersions('2.0.0', '2.0.1')).toBeLessThan(0);
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0);
  });

  it('tolerates a leading v and uneven lengths', () => {
    expect(compareVersions('v2.1', '2.0.9')).toBeGreaterThan(0);
    expect(compareVersions('2', '2.0.0')).toBe(0);
  });
});

describe('checkRelease', () => {
  const pkgMarker = { mode: 'packaged', target: 'win32-x64', version: '2.0.0' };
  const fakeFetch = (body, ok = true, status = 200) => async () => ({
    ok, status, json: async () => body,
  });

  it('reports up to date when the feed matches the installed version', async () => {
    const r = await checkRelease(pkgMarker, fakeFetch({ tag_name: 'v2.0.0', assets: [] }));
    expect(r.ok).toBe(true);
    expect(r.upToDate).toBe(true);
  });

  it('does not offer a downgrade when the feed is behind', async () => {
    const r = await checkRelease(pkgMarker, fakeFetch({ tag_name: 'v1.9.0', assets: [] }));
    expect(r.upToDate).toBe(true);
  });

  it('picks the .exe asset for a Windows build', async () => {
    const r = await checkRelease(pkgMarker, fakeFetch({
      tag_name: 'v2.1.0',
      assets: [
        { name: 'claude-web-ui_2.1.0_amd64.deb', browser_download_url: 'https://x/deb' },
        { name: 'claude-web-ui-2.1.0-setup.exe', browser_download_url: 'https://x/exe' },
      ],
    }));
    expect(r.upToDate).toBe(false);
    expect(r.latest).toBe('2.1.0');
    expect(r.url).toBe('https://x/exe');
  });

  it('picks the .deb asset for a Linux build', async () => {
    const r = await checkRelease({ ...pkgMarker, target: 'linux-x64' }, fakeFetch({
      tag_name: 'v2.1.0',
      assets: [
        { name: 'claude-web-ui-2.1.0-setup.exe', browser_download_url: 'https://x/exe' },
        { name: 'claude-web-ui_2.1.0_amd64.deb', browser_download_url: 'https://x/deb' },
      ],
    }));
    expect(r.url).toBe('https://x/deb');
  });

  it('falls back to the release page when no matching asset is published', async () => {
    const r = await checkRelease(pkgMarker, fakeFetch({
      tag_name: 'v2.1.0', assets: [], html_url: 'https://github.com/x/releases/tag/v2.1.0',
    }));
    expect(r.url).toBe('https://github.com/x/releases/tag/v2.1.0');
  });

  it('reports a network failure instead of throwing', async () => {
    const r = await checkRelease(pkgMarker, async () => { throw new Error('getaddrinfo ENOTFOUND'); });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/ENOTFOUND/);
  });

  it('reports an HTTP error instead of throwing', async () => {
    const r = await checkRelease(pkgMarker, fakeFetch({}, false, 403));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/403/);
  });
});

describe('runUpdate on a packaged install', () => {
  it('checks the feed and never signals a restart', async () => {
    marker({ mode: 'packaged', target: 'linux-x64', version: '2.0.0' });
    const out = [];
    const r = await runUpdate((d) => out.push(d), {
      appRoot: tmp,
      fetchImpl: async () => ({
        ok: true, status: 200,
        json: async () => ({
          tag_name: 'v2.2.0',
          assets: [{ name: 'claude-web-ui_2.2.0_amd64.deb', browser_download_url: 'https://x/deb' }],
        }),
      }),
    });

    expect(r.ok).toBe(true);
    // The key property: a packaged install must never restart itself here,
    // because nothing on disk changed.
    expect(r.shouldRestart).toBe(false);
    expect(r.url).toBe('https://x/deb');
    expect(out.join('')).toMatch(/2\.2\.0 is available/);
    expect(out.join('')).toMatch(/https:\/\/x\/deb/);
  });

  it('says so when already current, and still does not restart', async () => {
    marker({ mode: 'packaged', target: 'win32-x64', version: '3.0.0' });
    const out = [];
    const r = await runUpdate((d) => out.push(d), {
      appRoot: tmp,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ tag_name: 'v3.0.0', assets: [] }) }),
    });
    expect(r.ok).toBe(true);
    expect(r.shouldRestart).toBe(false);
    expect(out.join('')).toMatch(/Already on the latest/);
  });

  it('without a marker, falls through to the git path', async () => {
    // tmp has no .git and no marker -> the dev path's own guard should fire,
    // proving we did not take the packaged branch.
    const out = [];
    const r = await runUpdate((d) => out.push(d), { appRoot: tmp });
    expect(r.ok).toBe(false);
    expect(out.join('')).toMatch(/not a git repo/);
  });
});
