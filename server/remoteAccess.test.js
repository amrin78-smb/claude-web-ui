// describe/it/expect come from Vitest's `globals: true` (see vitest.config.ts).
// A locally generated RSA key stands in for the team's Access signing key; the
// fetcher hands its JWK back as the team's published certs.
const crypto = require('crypto');
const ra = require('./remoteAccess');

const PORT = 4280;
const TEAM = 'team.cloudflareaccess.com';
const AUD = 'a'.repeat(64);
const cfg = { remote: { hostname: 'cc.example.com', teamDomain: TEAM, aud: AUD } };

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const fetcher = async () => ({ keys: [jwk] });

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
function sign(payload, { header = { alg: 'RS256', kid: 'k1' }, key = privateKey } = {}) {
  const head = `${b64(header)}.${b64(payload)}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(head), key).toString('base64url');
  return `${head}.${sig}`;
}
const now = Math.floor(Date.now() / 1000);
const good = { aud: [AUD], iss: `https://${TEAM}`, exp: now + 3600, iat: now, email: 'me@example.com' };

const tunnelled = token => ({ headers: { host: 'cc.example.com', 'cf-ray': 'abc', 'cf-access-jwt-assertion': token } });

describe('remoteAccess', () => {
  beforeEach(() => ra._keyCache.clear());

  it('lets plain local requests through without any token', async () => {
    expect(await ra.check({ headers: { host: '127.0.0.1:4280' } }, { port: PORT, cfg: {}, fetcher })).toEqual({ ok: true, remote: false });
    expect((await ra.check({ headers: { host: 'localhost:4280' } }, { port: PORT, cfg: {}, fetcher })).ok).toBe(true);
  });

  it('treats anything that came through Cloudflare as remote, even with a loopback Host', async () => {
    const r = await ra.check({ headers: { host: '127.0.0.1:4280', 'cf-ray': 'x' } }, { port: PORT, cfg: {}, fetcher });
    expect(r).toMatchObject({ ok: false, remote: true });
  });

  it('refuses a foreign Host (DNS rebinding) when remote access is off', async () => {
    const r = await ra.check({ headers: { host: 'evil.example:4280' } }, { port: PORT, cfg: {}, fetcher });
    expect(r).toMatchObject({ ok: false, reason: 'remote access is not set up on this server' });
  });

  it('accepts a valid Access token from the header or the cookie', async () => {
    expect(await ra.check(tunnelled(sign(good)), { port: PORT, cfg, fetcher })).toEqual({ ok: true, remote: true, email: 'me@example.com' });
    const viaCookie = { headers: { host: 'cc.example.com', 'cf-ray': 'abc', cookie: `a=1; CF_Authorization=${sign(good)}` } };
    expect((await ra.check(viaCookie, { port: PORT, cfg, fetcher })).ok).toBe(true);
  });

  it('refuses a tunnelled request with no token', async () => {
    expect(await ra.check({ headers: { host: 'cc.example.com', 'cf-ray': 'abc' } }, { port: PORT, cfg, fetcher }))
      .toMatchObject({ ok: false, reason: 'no Access token' });
  });

  it.each([
    ['wrong audience', sign({ ...good, aud: ['b'.repeat(64)] })],
    ['wrong issuer', sign({ ...good, iss: 'https://other.cloudflareaccess.com' })],
    ['expired', sign({ ...good, exp: now - 3600 })],
    ['bad signature', sign(good, { key: other.privateKey })],
    ['unexpected algorithm', sign(good, { header: { alg: 'HS256', kid: 'k1' } })],
    ['unexpected algorithm', `${b64({ alg: 'none', kid: 'k1' })}.${b64(good)}.`],
    ['unknown signing key', sign(good, { header: { alg: 'RS256', kid: 'nope' } })],
    ['malformed token', 'not.a-jwt'],
  ])('refuses: %s', async (reason, token) => {
    const r = await ra.check(tunnelled(token), { port: PORT, cfg, fetcher });
    expect(r).toMatchObject({ ok: false, reason });
  });

  it('fails closed when the signing keys cannot be fetched', async () => {
    const broken = async () => { throw new Error('offline'); };
    const r = await ra.check(tunnelled(sign(good)), { port: PORT, cfg, fetcher: broken });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/could not load Access keys/);
  });

  it('caches the keys instead of fetching them per request', async () => {
    let calls = 0;
    const counting = async () => { calls++; return { keys: [jwk] }; };
    for (let i = 0; i < 5; i++) await ra.check(tunnelled(sign(good)), { port: PORT, cfg, fetcher: counting });
    expect(calls).toBe(1);
  });

  it('needs all three settings, and tolerates pasted URLs', () => {
    expect(ra.remoteSettings({ remote: { hostname: 'cc.example.com', teamDomain: TEAM } })).toBeNull();
    expect(ra.remoteSettings({ remote: { hostname: 'https://CC.example.com/', teamDomain: `https://${TEAM}/`, aud: AUD } }))
      .toEqual({ hostname: 'cc.example.com', teamDomain: TEAM, aud: AUD, origin: 'https://cc.example.com' });
  });
});
