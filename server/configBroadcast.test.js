/* A restore rewrites config.json underneath every connected tab.
 *
 * This is the bug these tests exist for: restore reloaded the SESSION list and
 * announced it, but said nothing about the config. Tabs kept the pre-restore
 * config, so Settings showed an empty Workspace Repos list — and because a save
 * pushes the WHOLE client config rather than a diff (and addRecent() saves on
 * every new session), that stale tab would then write its emptiness back over
 * the restored file. The data was fine on disk and silently reverted later.
 *
 * So the property under test is not "restore writes config" — it did — but
 * "every writer of config.json announces it to every client".
 *
 * describe/it/expect/vi come from Vitest's `globals: true` (see vitest.config.ts).
 */
const fs = require('fs');
const path = require('path');

const INDEX_SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');

describe('config broadcast', () => {
  // These are structural checks on index.js rather than a live server: the ws
  // wiring needs a real port and a real sessionManager, and what actually
  // regressed here is *which call sites announce a config change*. A duplicated
  // payload shape is what let restore quietly use neither.
  it('builds the config wire payload in exactly one place', () => {
    // The shape used to be spelled out per call site; if that comes back, a new
    // writer can forget to broadcast again.
    const inlinePayloads = INDEX_SRC.split("type: 'config'").length - 1;
    expect(inlinePayloads).toBe(1);
  });

  it('has a broadcast that reaches every open client', () => {
    expect(INDEX_SRC).toMatch(/function broadcastConfig\(\)/);
    const fn = INDEX_SRC.slice(INDEX_SRC.indexOf('function broadcastConfig()'));
    expect(fn.slice(0, 400)).toMatch(/wss\.clients/);
  });

  it('announces the config after a restore, not just the session list', () => {
    const start = INDEX_SRC.indexOf("case 'restore':");
    expect(start).toBeGreaterThan(-1);
    const handler = INDEX_SRC.slice(start, INDEX_SRC.indexOf("case 'update':", start));
    // Both halves of the restored state have to reach the client: the session
    // list via reloadFromDisk(), the config via broadcastConfig().
    expect(handler).toMatch(/reloadFromDisk\(\)/);
    expect(handler).toMatch(/broadcastConfig\(\)/);
  });

  it('announces the config after a save', () => {
    const start = INDEX_SRC.indexOf("case 'saveconfig':");
    const handler = INDEX_SRC.slice(start, INDEX_SRC.indexOf('case ', start + 10));
    expect(handler).toMatch(/broadcastConfig\(\)/);
  });
});

describe('build announcement', () => {
  // The top bar shows which build you're looking at, which only works if the
  // server volunteers it — the client never asks, because it cannot change
  // while the process lives.
  it('sends the build info unprompted on connect', () => {
    const start = INDEX_SRC.indexOf("wss.on('connection'");
    const onConnect = INDEX_SRC.slice(start, INDEX_SRC.indexOf("ws.on('message'", start));
    expect(onConnect).toMatch(/send\(BUILD\)/);
  });

  it('resolves the version and install mode once, not per connection', () => {
    // Re-reading package.json and the install marker per socket would be waste
    // for a value that is fixed for the life of the process.
    const start = INDEX_SRC.indexOf('const BUILD =');
    expect(start).toBeGreaterThan(-1);
    expect(start).toBeLessThan(INDEX_SRC.indexOf("wss.on('connection'"));
    const body = INDEX_SRC.slice(start, INDEX_SRC.indexOf('})();', start));
    expect(body).toMatch(/package\.json/);
    expect(body).toMatch(/installMode\(\)/);
  });

  it('survives an unreadable package.json rather than failing to boot', () => {
    // The chip disappearing is acceptable; the server refusing to start is not.
    const start = INDEX_SRC.indexOf('const BUILD =');
    const body = INDEX_SRC.slice(start, INDEX_SRC.indexOf('})();', start));
    expect(body).toMatch(/try\s*{/);
    expect(body).toMatch(/catch/);
  });
});

describe('config payload shape', () => {
  // The payload must cover every field the CLIENT keeps, because a field that
  // never arrives leaves that key at whatever the store already had — stale by
  // omission rather than by timing. Checked against the client's own DEFAULT so
  // the two sides can't drift: add a config field to the UI without adding it
  // here and this fails.
  //
  // Not every persisted field belongs on the wire: loadConfig() also normalizes
  // `cwd`, which is server-only (index.js uses it as a default working folder)
  // and deliberately absent from the client's Config type.
  const CLIENT_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'web', 'src', 'stores', 'config.ts'), 'utf8');

  function clientConfigFields() {
    const start = CLIENT_SRC.indexOf('const DEFAULT: Config = {');
    const body = CLIENT_SRC.slice(start, CLIENT_SRC.indexOf('};', start));
    return [...body.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
  }

  it('covers every field the client stores', () => {
    const fields = clientConfigFields();
    expect(fields.length).toBeGreaterThan(4); // the parse actually found something
    const start = INDEX_SRC.indexOf('function configPayload()');
    const body = INDEX_SRC.slice(start, INDEX_SRC.indexOf('\n}', start));
    for (const f of fields) {
      expect(body, `configPayload() is missing "${f}"`).toMatch(new RegExp(`\\b${f}\\s*:`));
    }
  });

  it('does not leak the server-only cwd onto the wire', () => {
    const start = INDEX_SRC.indexOf('function configPayload()');
    const body = INDEX_SRC.slice(start, INDEX_SRC.indexOf('\n}', start));
    expect(body).not.toMatch(/\bcwd\s*:/);
  });
});
