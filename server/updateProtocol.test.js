/* "Update app" has two outcomes that look alike and behave completely
 * differently, and conflating them is what this file guards against.
 *
 *   dev checkout   -> pulls, rebuilds, restarts. restarting: true. The panel
 *                     should wait for the socket to drop and come back, then
 *                     reload the page onto the new bundle.
 *   packaged build -> cannot rewrite itself, so it checks the release feed and
 *                     hands over an installer. restarting: false. Nothing was
 *                     installed and nothing will restart.
 *
 * The client ignored `restarting` and treated every success as the first case,
 * so a packaged install sat on "Update complete — restarting…" forever, waiting
 * for a reboot that was never coming — with no Close button, because that only
 * rendered on failure. It reads as a hung app, and the download link it was
 * actually offering was buried in the log text.
 *
 * describe/it/expect come from Vitest's `globals: true` (see vitest.config.ts).
 */
const fs = require('fs');
const path = require('path');

const INDEX_SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const SETTINGS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'src', 'components', 'Settings.svelte'), 'utf8');

// 'updatedone' is sent from more than one place: the busy-session refusal sends
// a hardcoded { ok: false, restarting: false } too. The final-outcome payload is
// the one whose result comes from runUpdate() rather than from a literal.
function updatedonePayload() {
  const blocks = [...INDEX_SRC.matchAll(/type: 'updatedone',/g)]
    .map((m) => INDEX_SRC.slice(m.index, INDEX_SRC.indexOf('});', m.index)));
  const final = blocks.find((b) => /ok:\s*r\.ok/.test(b));
  expect(final, "no 'updatedone' payload reports runUpdate()'s result").toBeTruthy();
  return final;
}

describe('updatedone carries the outcome, not just success', () => {
  it('says whether a restart is coming', () => {
    expect(updatedonePayload()).toMatch(/\brestarting\b/);
  });

  it('carries the installer url and version as data', () => {
    // Buried in the log text these are unusable: the panel needs to render a
    // real link, and a user should never have to copy a URL out of a log pane.
    const payload = updatedonePayload();
    expect(payload).toMatch(/\burl\b/);
    expect(payload).toMatch(/\blatest\b/);
  });
});

describe('the update panel honours restarting', () => {
  it('only waits for a reconnect when a restart was announced', () => {
    // The bug in one line: this effect used to fire for every success.
    const i = SETTINGS_SRC.indexOf('if (updatePhase !== ');
    expect(i).toBeGreaterThan(-1);
    const guard = SETTINGS_SRC.slice(i, SETTINGS_SRC.indexOf('\n', i));
    expect(guard).toMatch(/updateRestarting/);
  });

  it('records restarting, url and version from the reply', () => {
    const i = SETTINGS_SRC.indexOf("m.type === 'updatedone'");
    const handler = SETTINGS_SRC.slice(i, SETTINGS_SRC.indexOf('} else if', i));
    expect(handler).toMatch(/updateRestarting\s*=/);
    expect(handler).toMatch(/updateUrl\s*=/);
    expect(handler).toMatch(/updateLatest\s*=/);
  });

  it('offers a way out of a success that did not restart', () => {
    // Without this the panel is a dead end: no Close, and no reload coming.
    // Several modals have a modal-actions block; the update panel's is the one
    // wired to closeUpdatePanel.
    const actions = [...SETTINGS_SRC.matchAll(/<div class="modal-actions">/g)]
      .map((m) => SETTINGS_SRC.slice(m.index, SETTINGS_SRC.indexOf('</div>', m.index)))
      .find((b) => b.includes('closeUpdatePanel'));
    expect(actions, 'no modal-actions block closes the update panel').toBeTruthy();
    expect(actions).toMatch(/updatePhase === 'ok' && !updateRestarting/);
  });

  it('renders the installer as a link rather than log text', () => {
    expect(SETTINGS_SRC).toMatch(/href=\{updateUrl\}/);
  });

  it('does not claim "complete" when nothing was installed', () => {
    // The heading drove the misreading as much as the spinner did.
    const i = SETTINGS_SRC.indexOf('Update complete');
    const heading = SETTINGS_SRC.slice(Math.max(0, i - 200), i);
    expect(heading).toMatch(/updateRestarting/);
  });
});
