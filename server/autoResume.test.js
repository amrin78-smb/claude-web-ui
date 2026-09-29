/* Auto-resume: opening a stopped session starts it instead of asking.
 *
 * The risk in this feature is not "does it resume" but "when does it fire".
 * Two ways to get it wrong, both bad:
 *
 *   keyed on status  -> a Claude that exits immediately (bad flag, crash on
 *                       startup) gets respawned the instant it dies, forever,
 *                       with the overlay never staying up long enough to show
 *                       why. An invisible restart loop.
 *   fired for every  -> a restored server has every session as a ghost, so
 *   session at once     connecting would fork a Claude per session, for tabs
 *                       the user may never open.
 *
 * So it is keyed on a tab BECOMING ACTIVE, once per opening. These are
 * structural checks on the component — the behaviour itself needs a browser,
 * and the properties worth protecting are visible in the source.
 *
 * describe/it/expect come from Vitest's `globals: true` (see vitest.config.ts).
 */
const fs = require('fs');
const path = require('path');

const TERMINAL_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'src', 'components', 'Terminal.svelte'), 'utf8');

// The auto-resume effect: the one that mentions autoStartedFor.
function autoResumeEffect() {
  const marker = TERMINAL_SRC.indexOf('autoStartedFor === session.id');
  expect(marker, 'no auto-resume effect found').toBeGreaterThan(-1);
  const start = TERMINAL_SRC.lastIndexOf('$effect(() => {', marker);
  return TERMINAL_SRC.slice(start, TERMINAL_SRC.indexOf('\n  });', marker));
}

describe('auto-resume fires on opening a tab, not on a session dying', () => {
  it('does nothing unless the tab is active', () => {
    expect(autoResumeEffect()).toMatch(/if \(!active\)/);
  });

  it('forgets it ran once the tab is deactivated, so reopening starts it again', () => {
    const body = autoResumeEffect();
    const early = body.slice(0, body.indexOf('\n', body.indexOf('if (!active)')));
    expect(early).toMatch(/autoStartedFor = ''/);
  });

  it('runs at most once per opening', () => {
    const body = autoResumeEffect();
    // The guard that stops a re-run, and the assignment that arms it.
    expect(body).toMatch(/if \(autoStartedFor === session\.id\) return;/);
    expect(body).toMatch(/autoStartedFor = session\.id;/);
  });

  it('respects the setting', () => {
    expect(autoResumeEffect()).toMatch(/\$config\.autoResume/);
  });

  it('resumes a session with history and starts a fresh one without', () => {
    const body = autoResumeEffect();
    expect(body).toMatch(/session\.resumable/);
    expect(body).toMatch(/\bresume\(\)/);
    expect(body).toMatch(/startFresh\(\)/);
  });

  it('suppresses the overlay while it is starting, so it does not flash', () => {
    expect(TERMINAL_SRC).toMatch(/showOverlay = \$derived\([^)]*!autoStarting/);
  });
});

describe('the setting survives a round trip', () => {
  const { loadConfig } = require('./config');
  const fsMod = require('fs');

  afterEach(() => vi.restoreAllMocks());

  it('defaults on, so an existing config.json gets the new behaviour', () => {
    vi.spyOn(fsMod, 'readFileSync').mockReturnValue(JSON.stringify({ repoUrl: 'x' }));
    expect(loadConfig().autoResume).toBe(true);
  });

  it('can be turned off and stays off', () => {
    vi.spyOn(fsMod, 'readFileSync').mockReturnValue(JSON.stringify({ autoResume: false }));
    expect(loadConfig().autoResume).toBe(false);
  });
});
