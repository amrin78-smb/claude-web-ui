/* Remote access through Cloudflare Access.
 *
 * The server only ever listens on 127.0.0.1. Remote use comes in through a
 * Cloudflare Tunnel (cloudflared on this machine connects to localhost), with a
 * Cloudflare Access app in front that makes the person log in. That means
 * "it connected to 127.0.0.1" no longer implies "it came from this machine": a
 * tunnelled request is a loopback connection too. So every request is sorted
 * into one of two kinds:
 *
 *   local   — Host is this server's own loopback address and nothing about it
 *             came through Cloudflare. Allowed, exactly as before.
 *   remote  — anything else. Allowed only with a valid Access JWT for the
 *             configured app (signature against the team's published keys,
 *             audience, issuer, expiry). Not configured means refused.
 *
 * Failing closed is the point. If the Access app were ever deleted or
 * misconfigured, the tunnel would hand requests straight to us, and a session
 * runs Claude with --dangerously-skip-permissions: an open page is a shell. The
 * Host check also closes DNS rebinding (a web page whose name resolves to
 * 127.0.0.1 sends its own Host), which the old Origin-only check let through
 * for plain HTTP.
 */
const crypto = require('crypto');
const https = require('https');

const CF_HEADERS = ['cf-ray', 'cf-connecting-ip', 'cf-access-jwt-assertion', 'cf-visitor'];

function localHosts(port) {
  return new Set([
    `127.0.0.1:${port}`, `localhost:${port}`,
    // Vite dev server proxies /api and /ws here with its own Host.
    '127.0.0.1:5173', 'localhost:5173',
  ]);
}

function isLocalRequest(req, port) {
  const host = String(req.headers.host || '').toLowerCase();
  if (!localHosts(port).has(host)) return false;
  return !CF_HEADERS.some(h => h in req.headers);
}

// The remote settings from config.json, or null when they are not all there.
// `hostname` is what people type (cc.example.com), `teamDomain` the Zero Trust
// team's login domain (team.cloudflareaccess.com), `aud` the Access app's
// Application Audience tag.
function remoteSettings(cfg) {
  const r = (cfg && cfg.remote) || {};
  const hostname = String(r.hostname || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const teamDomain = String(r.teamDomain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const aud = String(r.aud || '').trim();
  if (!hostname || !teamDomain || !aud) return null;
  return { hostname, teamDomain, aud, origin: `https://${hostname}` };
}

// ---- JWT verification ------------------------------------------------------

function b64urlJson(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

function tokenFrom(req) {
  const h = req.headers['cf-access-jwt-assertion'];
  if (h) return String(h);
  const m = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(String(req.headers.cookie || ''));
  return m ? m[1] : '';
}

// The team's signing keys, cached. Access rotates them, so an unknown `kid`
// triggers one refetch (rate-limited, so junk tokens can't make us hammer it).
const keyCache = new Map(); // teamDomain -> { keys: Map<kid, KeyObject>, fetchedAt }
const REFETCH_MS = 60 * 1000;
const MAX_AGE_MS = 60 * 60 * 1000;

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 8000 }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`certs: HTTP ${res.statusCode}`)); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; if (body.length > 1e6) req.destroy(new Error('certs: too large')); });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('certs: timeout')));
    req.on('error', reject);
  });
}

async function loadKeys(teamDomain, fetcher) {
  const body = await fetcher(`https://${teamDomain}/cdn-cgi/access/certs`);
  const keys = new Map();
  for (const jwk of (body && body.keys) || []) {
    try { keys.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' })); } catch {}
  }
  const entry = { keys, fetchedAt: Date.now() };
  keyCache.set(teamDomain, entry);
  return entry;
}

async function keyFor(teamDomain, kid, fetcher) {
  let entry = keyCache.get(teamDomain);
  const stale = !entry || Date.now() - entry.fetchedAt > MAX_AGE_MS;
  const unknown = entry && !entry.keys.has(kid) && Date.now() - entry.fetchedAt > REFETCH_MS;
  if (stale || unknown) entry = await loadKeys(teamDomain, fetcher);
  return entry.keys.get(kid) || null;
}

// Verify an Access JWT. Resolves {ok: true, email} or {ok: false, reason}.
async function verifyToken(token, settings, { fetcher = fetchJson, now = Date.now() } = {}) {
  if (!token) return { ok: false, reason: 'no Access token' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed token' };
  let header, payload;
  try { header = b64urlJson(parts[0]); payload = b64urlJson(parts[1]); } catch { return { ok: false, reason: 'malformed token' }; }
  // RS256 only: never let the token pick its own algorithm ("none", HS256).
  if (header.alg !== 'RS256' || !header.kid) return { ok: false, reason: 'unexpected algorithm' };

  let key;
  try { key = await keyFor(settings.teamDomain, header.kid, fetcher); } catch (e) { return { ok: false, reason: `could not load Access keys: ${e.message}` }; }
  if (!key) return { ok: false, reason: 'unknown signing key' };
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
  const sig = Buffer.from(parts[2], 'base64url');
  if (!crypto.verify('RSA-SHA256', signed, key, sig)) return { ok: false, reason: 'bad signature' };

  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(settings.aud)) return { ok: false, reason: 'wrong audience' };
  if (payload.iss !== `https://${settings.teamDomain}`) return { ok: false, reason: 'wrong issuer' };
  const t = Math.floor(now / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < t - 30) return { ok: false, reason: 'expired' };
  if (typeof payload.nbf === 'number' && payload.nbf > t + 30) return { ok: false, reason: 'not yet valid' };
  return { ok: true, email: payload.email || '' };
}

// Decide one request. Resolves {ok, remote, email?, reason?}.
async function check(req, { port, cfg, fetcher } = {}) {
  if (isLocalRequest(req, port)) return { ok: true, remote: false };
  const settings = remoteSettings(cfg);
  if (!settings) return { ok: false, remote: true, reason: 'remote access is not set up on this server' };
  const v = await verifyToken(tokenFrom(req), settings, { fetcher });
  return v.ok ? { ok: true, remote: true, email: v.email } : { ok: false, remote: true, reason: v.reason };
}

module.exports = { isLocalRequest, remoteSettings, verifyToken, tokenFrom, check, _keyCache: keyCache };
