/* Web Push: "Claude needs you" / "finished" alerts that reach a device even
 * when the app isn't open — the phone-in-a-pocket case.
 *
 * The browser subscribes with this server's VAPID public key and hands us an
 * endpoint at its vendor's push service (Google, Mozilla, Apple, Microsoft).
 * We POST an encrypted payload there; the service wakes the browser, and the
 * service worker (web/public/sw.js) shows the notification. The payload is
 * end-to-end encrypted to the subscription's keys (web-push does the RFC 8291
 * work), so the push service never reads session titles or Claude's replies.
 *
 * State lives in STATE_DIR/push.json: the VAPID key pair (made once — a new
 * pair would orphan every subscription) and the subscriptions. Any push that
 * comes back 404/410 means that browser unsubscribed or was reset, so the
 * subscription is dropped.
 */
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');
const { STATE_DIR } = require('./paths');

const FILE = path.join(STATE_DIR, 'push.json');
const MAX_SUBSCRIPTIONS = 30;

// We POST to whatever endpoint a browser gives us, so only to the real push
// services: otherwise "subscribe" is a way to make this server send requests
// anywhere on the network.
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,             // Chrome, Edge on Android, Brave, Opera
  /^updates\.push\.services\.mozilla\.com$/, // Firefox
  /(^|\.)push\.apple\.com$/,            // Safari, iOS home-screen apps
  /(^|\.)notify\.windows\.com$/,        // Edge on Windows
];

let state = null;

function load() {
  if (state) return state;
  try { state = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { state = {}; }
  if (!state.publicKey || !state.privateKey) {
    const keys = webpush.generateVAPIDKeys();
    state = { publicKey: keys.publicKey, privateKey: keys.privateKey, subscriptions: [] };
    save();
  }
  if (!Array.isArray(state.subscriptions)) state.subscriptions = [];
  return state;
}

function save() {
  try {
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error('push: failed to save', err.message);
  }
}

function publicKey() {
  return load().publicKey;
}

// Reduce a PushSubscription (as JSON) to what sending needs, or null.
function parseSubscription(sub) {
  if (!sub || typeof sub !== 'object') return null;
  let url;
  try { url = new URL(String(sub.endpoint || '')); } catch { return null; }
  if (url.protocol !== 'https:' || !PUSH_HOSTS.some(re => re.test(url.hostname))) return null;
  const k = sub.keys || {};
  const ok = s => typeof s === 'string' && s.length > 0 && s.length < 200 && /^[A-Za-z0-9_-]+=*$/.test(s);
  if (!ok(k.p256dh) || !ok(k.auth)) return null;
  return { endpoint: url.href, keys: { p256dh: k.p256dh, auth: k.auth } };
}

function subscribe(sub, label = '') {
  const s = parseSubscription(sub);
  if (!s) return { ok: false, error: 'not a push subscription from a known push service' };
  const st = load();
  st.subscriptions = st.subscriptions.filter(x => x.endpoint !== s.endpoint);
  st.subscriptions.push({ ...s, label: String(label || '').slice(0, 120), added: Date.now() });
  // Oldest out first: a device re-subscribing moves to the end.
  while (st.subscriptions.length > MAX_SUBSCRIPTIONS) st.subscriptions.shift();
  save();
  return { ok: true };
}

function unsubscribe(endpoint) {
  const st = load();
  const before = st.subscriptions.length;
  st.subscriptions = st.subscriptions.filter(x => x.endpoint !== endpoint);
  if (st.subscriptions.length !== before) save();
  return { ok: true, removed: before - st.subscriptions.length };
}

function isSubscribed(endpoint) {
  return load().subscriptions.some(x => x.endpoint === endpoint);
}

// The VAPID "subject" identifies the sender to the push services. Apple
// rejects one it can't parse (a localhost URL, for instance), and an email
// address would hand the user's identity to every push vendor, so: the remote
// origin when there is one, else a neutral placeholder.
function subject(cfg) {
  const host = cfg && cfg.remote && cfg.remote.hostname;
  return host ? `https://${String(host).replace(/^https?:\/\//, '').replace(/\/.*$/, '')}` : 'mailto:claude-web-ui@example.com';
}

// Send `payload` (an object, JSON-encoded) to every subscription, or only to
// `opts.endpoint`. Never throws; resolves {sent, failed, removed}.
async function notify(payload, { cfg, endpoint, send = webpush.sendNotification.bind(webpush) } = {}) {
  const st = load();
  const targets = st.subscriptions.filter(s => !endpoint || s.endpoint === endpoint);
  const body = JSON.stringify(payload);
  const options = {
    TTL: 6 * 3600,
    urgency: 'high',
    // A newer alert about the same session replaces one still queued.
    topic: payload.tag ? String(payload.tag).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) : undefined,
    vapidDetails: { subject: subject(cfg), publicKey: st.publicKey, privateKey: st.privateKey },
  };
  let sent = 0, failed = 0;
  const gone = [];
  await Promise.all(targets.map(async s => {
    try {
      await send({ endpoint: s.endpoint, keys: s.keys }, body, options);
      sent++;
    } catch (err) {
      failed++;
      if (err && (err.statusCode === 404 || err.statusCode === 410)) gone.push(s.endpoint);
      else console.error('push: send failed', err && (err.statusCode || err.message));
    }
  }));
  if (gone.length) {
    st.subscriptions = st.subscriptions.filter(s => !gone.includes(s.endpoint));
    save();
  }
  return { sent, failed, removed: gone.length };
}

module.exports = { publicKey, parseSubscription, subscribe, unsubscribe, isSubscribed, notify, subject, _reset: () => { state = null; }, FILE };
