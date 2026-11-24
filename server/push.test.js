// describe/it/expect/vi come from Vitest's `globals: true` (see vitest.config.ts).
// push.js keeps its keys and subscriptions in STATE_DIR/push.json; the fs calls
// are stubbed (after the require — see CLAUDE.md) so no real file is touched.
const fs = require('fs');
const push = require('./push');

const FCM = 'https://fcm.googleapis.com/fcm/send/abc123';
const sub = (endpoint = FCM) => ({ endpoint, keys: { p256dh: 'BPk' + 'x'.repeat(84), auth: 'a1b2c3d4e5f6g7h8i9j0kk' } });

describe('push', () => {
  let written;
  beforeEach(() => {
    written = null;
    push._reset();
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw new Error('ENOENT'); });
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data) => { written = JSON.parse(data); });
  });
  afterEach(() => vi.restoreAllMocks());

  it('makes a VAPID key pair once and keeps it private on disk', () => {
    const key = push.publicKey();
    expect(key).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    expect(written.privateKey).toBeTruthy();
    expect(fs.writeFileSync.mock.calls[0][2]).toMatchObject({ mode: 0o600 });
    expect(push.publicKey()).toBe(key);
  });

  it('only accepts endpoints at real push services', () => {
    expect(push.parseSubscription(sub())).toBeTruthy();
    expect(push.parseSubscription(sub('https://web.push.apple.com/QGx'))).toBeTruthy();
    expect(push.parseSubscription(sub('https://updates.push.services.mozilla.com/wpush/v2/x'))).toBeTruthy();
    expect(push.parseSubscription(sub('https://wns2-par02p.notify.windows.com/w/?token=x'))).toBeTruthy();
    expect(push.parseSubscription(sub('http://fcm.googleapis.com/x'))).toBeNull();
    expect(push.parseSubscription(sub('https://127.0.0.1:4280/api/update'))).toBeNull();
    expect(push.parseSubscription(sub('https://fcm.googleapis.com.evil.example/x'))).toBeNull();
    expect(push.parseSubscription({ endpoint: FCM, keys: { p256dh: 'has spaces', auth: 'x' } })).toBeNull();
  });

  it('subscribes once per endpoint and unsubscribes', () => {
    expect(push.subscribe(sub(), 'Chrome on Android').ok).toBe(true);
    expect(push.subscribe(sub(), 'Chrome on Android').ok).toBe(true);
    expect(written.subscriptions).toHaveLength(1);
    expect(push.isSubscribed(FCM)).toBe(true);
    push.unsubscribe(FCM);
    expect(push.isSubscribed(FCM)).toBe(false);
  });

  it('sends the payload to each device and drops ones the push service says are gone', async () => {
    push.subscribe(sub(FCM));
    push.subscribe(sub('https://web.push.apple.com/gone'));
    const send = vi.fn(async (s) => {
      if (s.endpoint.endsWith('/gone')) { const e = new Error('Gone'); e.statusCode = 410; throw e; }
    });
    const r = await push.notify({ kind: 'idle', title: 'Claude finished — web', body: 'done', tag: 's-1234' }, { cfg: {}, send });
    expect(r).toEqual({ sent: 1, failed: 1, removed: 1 });
    expect(JSON.parse(send.mock.calls[0][1])).toMatchObject({ title: 'Claude finished — web' });
    expect(send.mock.calls[0][2]).toMatchObject({ urgency: 'high', topic: 's-1234' });
    expect(push.isSubscribed('https://web.push.apple.com/gone')).toBe(false);
  });

  it('only targets one device for a test push', async () => {
    push.subscribe(sub(FCM));
    push.subscribe(sub('https://web.push.apple.com/other'));
    const send = vi.fn(async () => {});
    await push.notify({ kind: 'test' }, { endpoint: FCM, send });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].endpoint).toBe(FCM);
  });

  it('identifies as the remote origin, never the user, to push services', () => {
    expect(push.subject({ remote: { hostname: 'cc.example.com' } })).toBe('https://cc.example.com');
    expect(push.subject({})).toBe('mailto:claude-web-ui@example.com');
  });
});
