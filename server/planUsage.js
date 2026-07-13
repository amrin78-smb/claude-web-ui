/* Account-wide plan usage (5-hour rolling window + weekly window), read from
 * the same OAuth credential Claude Code itself uses.
 *
 * This calls Anthropic's internal `/api/oauth/usage` endpoint — the same one
 * the CLI's own `/status` output is built from. It's not part of the public
 * API, so treat failures as "unavailable" rather than fatal.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_SCOPE = 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';

function readCredentials() {
  const raw = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const oauth = raw.claudeAiOauth;
  if (!oauth || !oauth.accessToken) throw new Error('no Claude OAuth credentials found');
  return oauth;
}

function writeCredentials(oauth) {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8')); } catch {}
  raw.claudeAiOauth = { ...raw.claudeAiOauth, ...oauth };
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(raw, null, 2));
}

async function refreshAccessToken(oauth) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: oauth.refreshToken,
      client_id: CLIENT_ID,
      scope: OAUTH_SCOPE,
    }),
  });
  if (!res.ok) throw new Error(`token refresh failed: ${res.status}`);
  const body = await res.json();
  const next = {
    ...oauth,
    accessToken: body.access_token,
    refreshToken: body.refresh_token || oauth.refreshToken,
    expiresAt: Date.now() + body.expires_in * 1000,
    refreshTokenExpiresAt: body.refresh_token_expires_in
      ? Date.now() + body.refresh_token_expires_in * 1000
      : oauth.refreshTokenExpiresAt,
  };
  writeCredentials(next);
  return next;
}

// Refreshes ahead of expiry (60s of slack) so the usage call doesn't race it.
async function getValidOAuth() {
  let oauth = readCredentials();
  if (!oauth.expiresAt || oauth.expiresAt - Date.now() < 60_000) {
    oauth = await refreshAccessToken(oauth);
  }
  return oauth;
}

// Normalizes the per-window entries the endpoint returns (keyed by rate-limit
// window name) into a flat, UI-friendly shape. `utilization` here is already
// a 0-100 percent (not a fraction) and `resets_at` is an ISO timestamp string
// — confirmed against the live endpoint, which differs slightly from what the
// CLI binary's internal field names implied.
function normalize(oauth, raw) {
  const limits = Array.isArray(raw && raw.limits) ? raw.limits : [];
  const findLimit = (kind) => limits.find((l) => l.kind === kind) || null;

  const pick = (key, limitKind) => {
    const w = raw && raw[key];
    if (!w || typeof w.utilization !== 'number') return null;
    const l = limitKind ? findLimit(limitKind) : null;
    return {
      percent: w.utilization,
      resetsAt: w.resets_at ? Date.parse(w.resets_at) : null,
      severity: l ? l.severity : null,
    };
  };

  const spend = raw && raw.spend;
  return {
    subscriptionType: oauth.subscriptionType || null,
    rateLimitTier: oauth.rateLimitTier || null,
    fiveHour: pick('five_hour', 'session'),
    sevenDay: pick('seven_day', 'weekly_all'),
    sevenDayOpus: pick('seven_day_opus'),
    sevenDaySonnet: pick('seven_day_sonnet'),
    spend: spend && spend.enabled
      ? { percent: spend.percent, usedMinor: spend.used?.amount_minor, currency: spend.used?.currency }
      : null,
  };
}

// Cache briefly — several browser tabs may poll this at once.
let cache = null;
let cacheAt = 0;
const CACHE_MS = 20_000;

async function getPlanUsage() {
  if (cache && Date.now() - cacheAt < CACHE_MS) return cache;

  const oauth = await getValidOAuth();
  const res = await fetch(USAGE_URL, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${oauth.accessToken}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`usage fetch failed: ${res.status}`);
  const raw = await res.json();

  cache = normalize(oauth, raw);
  cacheAt = Date.now();
  return cache;
}

module.exports = { getPlanUsage };
