// describe/it/expect come from Vitest's `globals: true` (see vitest.config.ts).
const bridge = require('./bridge');

describe('bridge', () => {
  it('parses versions out of `claude --version` output', () => {
    expect(bridge.parseVersion('2.1.331 (Claude Code)')).toEqual([2, 1, 331]);
    expect(bridge.parseVersion('nonsense')).toBeNull();
  });

  it('compares versions field by field, not as strings', () => {
    expect(bridge.atLeast([2, 1, 287], [2, 1, 287])).toBe(true);
    expect(bridge.atLeast([2, 1, 1000], [2, 1, 287])).toBe(true);
    expect(bridge.atLeast([2, 1, 99], [2, 1, 287])).toBe(false);
    expect(bridge.atLeast([3, 0, 0], [2, 1, 287])).toBe(true);
  });

  it('launches with the mod and its env once configured, and not for a CLI that predates mods', () => {
    bridge.configure({ port: 4999 });
    bridge.setCliVersion('2.1.331');
    const l = bridge.launchFor('abc', {});
    expect(l.args).toEqual(['--plugin-dir', bridge.MOD_DIR]);
    expect(l.env).toEqual({
      CLAUDE_WEB_UI_BRIDGE: 'http://127.0.0.1:4999/api/bridge',
      CLAUDE_WEB_UI_SESSION: 'abc',
      CLAUDE_WEB_UI_TOKEN: bridge.TOKEN,
    });

    expect(bridge.launchFor('abc', { CLAUDE_WEB_UI_NO_MOD: '1' })).toEqual({ args: [], env: {} });
    expect(bridge.launchFor('', {})).toEqual({ args: [], env: {} });

    bridge.setCliVersion('2.1.200 (Claude Code)');
    expect(bridge.launchFor('abc', {})).toEqual({ args: [], env: {} });
    bridge.setCliVersion('');  // unknown: assume current
    expect(bridge.launchFor('abc', {}).args).toHaveLength(2);
  });

  it('checks the token in constant time and rejects anything else', () => {
    expect(bridge.authorized(bridge.TOKEN)).toBe(true);
    expect(bridge.authorized('')).toBe(false);
    expect(bridge.authorized(bridge.TOKEN + 'x')).toBe(false);
  });

  it('reduces posted bodies to known types with bounded fields', () => {
    expect(bridge.parseEvent({ type: 'rm -rf', session: 'a' })).toBeNull();
    expect(bridge.parseEvent({ type: 'turn.start' })).toBeNull();
    expect(bridge.parseEvent(null)).toBeNull();
    expect(bridge.parseEvent({ type: 'ask', session: 'a', kind: 'evil', text: 'x'.repeat(1000) }))
      .toEqual({ type: 'ask', session: 'a', kind: 'question', text: 'x'.repeat(300) });
    expect(bridge.parseEvent({ type: 'measure', session: 'a', context: { tokens: 5, window: 10, percent: 'lots' }, cost: 0.5 }))
      .toEqual({ type: 'measure', session: 'a', context: { tokens: 5, window: 10, percent: undefined }, cost: 0.5 });
    expect(bridge.parseEvent({ type: 'turn.complete', session: 'a', answer: 7 }))
      .toEqual({ type: 'turn.complete', session: 'a', reason: 'answer', answer: '' });
  });
});
