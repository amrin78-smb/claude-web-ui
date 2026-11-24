/* The bridge between a session's Claude process and this server.
 *
 * Every session is launched with the mod in `mod/` (`--plugin-dir`), which
 * posts what the CLI is doing — turn start/finish, a question waiting on the
 * person, context fill, cost — to POST /api/bridge. That replaces guessing from
 * terminal output, which can't tell "thinking quietly" from "done", or "done"
 * from "waiting for your answer".
 *
 * The token is minted per server run and handed to each pty via its env, so
 * only processes this server started can post. Sessions never outlive the
 * server (a restart kills every pty), so a fresh token each run costs nothing.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MOD_DIR = path.join(__dirname, '..', 'mod');
const TOKEN = crypto.randomBytes(24).toString('hex');

// Mods (a plugin's hooks module) arrived in Claude Code 2.1.287. An older CLI
// would read the mod's hooks.json as a broken settings-hooks file, so it is
// only passed to a CLI known to understand it — or one whose version we could
// not read, since the CLI auto-updates and a failed `--version` is far more
// likely a slow first run than a two-month-old install.
const MIN_VERSION = [2, 1, 287];

let port = null;
let cliVersion = null;

function configure(opts) {
  if (opts.port != null) port = opts.port;
}

function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function atLeast(v, min) {
  for (let i = 0; i < 3; i++) {
    if (v[i] !== min[i]) return v[i] > min[i];
  }
  return true;
}

function setCliVersion(text) {
  cliVersion = parseVersion(text);
}

function enabled(env = process.env) {
  if (env.CLAUDE_WEB_UI_NO_MOD === '1') return false;
  if (port == null) return false;
  if (cliVersion && !atLeast(cliVersion, MIN_VERSION)) return false;
  return fs.existsSync(path.join(MOD_DIR, 'hooks', 'hooks.json'));
}

// What spawnClaude adds for one session: the flag and the env the mod reads.
// `enabled()` false means nothing at all — a plain session, as before.
function launchFor(sessionId, env = process.env) {
  if (!sessionId || !enabled(env)) return { args: [], env: {} };
  return {
    args: ['--plugin-dir', MOD_DIR],
    env: {
      CLAUDE_WEB_UI_BRIDGE: `http://127.0.0.1:${port}/api/bridge`,
      CLAUDE_WEB_UI_SESSION: sessionId,
      CLAUDE_WEB_UI_TOKEN: TOKEN,
    },
  };
}

const TYPES = new Set(['start', 'turn.start', 'turn.complete', 'measure', 'ask', 'answered', 'end']);

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

// Reduce a posted body to the fields we act on, or null if it isn't one of
// ours. The poster is a process we launched, but its Bash children inherit the
// token, so the body is still treated as input: known types, bounded strings.
function parseEvent(body) {
  if (!body || typeof body !== 'object') return null;
  const type = body.type;
  if (!TYPES.has(type)) return null;
  const session = str(body.session, 100);
  if (!session) return null;
  const ev = { type, session };
  if (type === 'turn.complete') {
    ev.reason = str(body.reason, 20) || 'answer';
    ev.answer = str(body.answer, 400);
  } else if (type === 'ask') {
    ev.kind = body.kind === 'plan' ? 'plan' : 'question';
    ev.text = str(body.text, 300);
  } else if (type === 'measure') {
    const c = body.context && typeof body.context === 'object' ? body.context : {};
    ev.context = { tokens: num(c.tokens), window: num(c.window), percent: num(c.percent) };
    ev.cost = num(body.cost);
  } else if (type === 'end') {
    ev.conversation = str(body.conversation, 100);
  }
  return ev;
}

function authorized(header) {
  const a = Buffer.from(String(header || ''));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { MOD_DIR, MIN_VERSION, configure, setCliVersion, parseVersion, atLeast, enabled, launchFor, parseEvent, authorized, get TOKEN() { return TOKEN; } };
