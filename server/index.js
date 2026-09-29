/* Claude Code Web UI v2 — backend entrypoint.
 *
 * http + express + ws wiring. Serves the built frontend (web/dist) in production,
 * exposes the folder-browser REST endpoint, and drives the persistent multi-session
 * PTY manager over a WebSocket at /ws.
 *
 * Everything stays on localhost. PTYs live in sessionManager and survive reloads;
 * a WebSocket is just a transient subscriber.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const express = require('express');
const { WebSocketServer } = require('ws');

const { CLAUDE } = require('./claude');
const { loadConfig, saveConfig } = require('./config');
const { listDir } = require('./fs');
const { syncRepo, syncAllRepos, gitDiff } = require('./git');
const { runUpdate } = require('./update');
const { planBackup, createBackup, restoreBackup } = require('./backup');
const { installMode } = require('./update');
const sessions = require('./sessionManager');
const { getPlanUsage } = require('./planUsage');

const PORT = process.env.PORT || 4280;
const HOST = '127.0.0.1';

// Written on startup, removed on clean shutdown — lets "Stop Claude Web.bat"
// find and gracefully close this exact process even when it was launched
// hidden/detached (the Background.vbs launcher) with no console to Ctrl+C.
const PID_PATH = path.join(__dirname, '..', 'server.pid');

// Default working folder (used as the folder-browser default): saved config,
// then env/cwd, then the user's home.
const os = require('os');
function defaultCwd() {
  const cfg = loadConfig();
  if (cfg.cwd && fs.existsSync(cfg.cwd)) return cfg.cwd;
  let cwd = process.env.CLAUDE_WEB_CWD || process.cwd();
  if (!fs.existsSync(cwd)) cwd = os.homedir();
  return cwd;
}

// ---- HTTP / static -------------------------------------------------------
const app = express();
app.use(express.json({ limit: '64mb' }));

// In production the frontend is built to web/dist; serve it if present. In dev,
// Vite serves the UI itself, so this simply does nothing.
const distDir = path.join(__dirname, '..', 'web', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
}

// List drives + immediate subfolders for the folder browser.
app.get('/api/dirs', (req, res) => {
  try {
    // `fileExt` lets the picker also list matching files (e.g. '.zip' when
    // choosing a backup archive). Constrained to a short, dot-prefixed
    // extension: it reaches a filesystem listing, so don't accept a pattern.
    const raw = String(req.query.fileExt || '');
    const fileExt = /^\.[a-z0-9]{1,8}$/i.test(raw) ? raw : '';
    res.json(listDir(req.query.path, defaultCwd(), { fileExt }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Account-wide plan usage (5-hour + weekly windows). Best-effort: this relies
// on an undocumented Anthropic endpoint, so failures are reported, not fatal.
app.get('/api/plan-usage', async (req, res) => {
  try {
    res.json(await getPlanUsage());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

const server = http.createServer(app);

// Browsers do NOT apply same-origin policy to WebSockets — they send an Origin
// header and leave the decision to the server. Without this check, any page the
// user happens to have open in the same browser could connect to
// ws://127.0.0.1:4280/ws and drive a Claude running with
// --dangerously-skip-permissions: enumerate sessions, create one in any folder,
// type into it, write files through the image/file handlers. Binding to
// 127.0.0.1 does not help — that's about the network, not about other tabs.
//
// Non-browser clients (the scripted protocol tests, e.g. ws-life.js) send no
// Origin at all, and a page cannot suppress or forge its own Origin, so
// allowing the empty case keeps those working without weakening the check.
const ALLOWED_ORIGINS = new Set([
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`,
  'http://127.0.0.1:5173', // vite dev server (npm run dev) proxies /ws here
  'http://localhost:5173',
]);
const wss = new WebSocketServer({
  server,
  path: '/ws',
  verifyClient: ({ origin }) => !origin || ALLOWED_ORIGINS.has(origin),
});

// Attaching to an existing server makes ws re-emit that server's 'error' here
// too. Without a listener on this instance the duplicate is an unhandled 'error'
// event, so the process dies instantly — before server.on('error') below can run
// its EADDRINUSE retry. That retry is exactly what the self-update restart
// depends on, which meant a restart raced against the outgoing process just
// killed the incoming one and left nothing listening. The http server's handler
// owns the decision; this only stops the copy from being fatal.
wss.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') return; // server.on('error') retries
  console.error('  websocket server error:', (err && err.message) || err);
});

// What this server actually is, resolved once at startup. The UI shows it so
// "which build am I looking at?" has an answer without opening a dialog — this
// app is commonly run as BOTH a packaged install and a dev checkout on the same
// machine, and they are indistinguishable on screen otherwise.
const BUILD = (() => {
  let version = '';
  try {
    version = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version || '';
  } catch { /* a packaged tree always has one; a broken read just hides the chip */ }
  return { type: 'build', version, mode: installMode().mode };
})();

// The config wire payload, built in one place. Both the per-socket reply and
// the broadcasts below use it — when this shape was duplicated per call site,
// a new writer of config.json (restore) simply forgot to announce it.
function configPayload() {
  const cfg = loadConfig();
  return {
    type: 'config',
    repoUrl: cfg.repoUrl || '',
    branch: cfg.branch || '',
    autoSync: !!cfg.autoSync,
    autoResume: cfg.autoResume !== false,
    recents: cfg.recents || [],
    pinned: cfg.pinned || [],
    syncWorkDir: cfg.syncWorkDir || '',
    syncRepos: cfg.syncRepos || [],
  };
}

// Push the config on disk to every open tab. Any code path that rewrites
// config.json behind the clients' backs MUST call this: a tab that still holds
// the pre-change config will happily push it back on the next save — and every
// save sends the whole config, not a diff, so a stale tab silently reverts the
// file. addRecent() saves on every new session, so that is not a rare path.
function broadcastConfig() {
  const json = JSON.stringify(configPayload());
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(json);
  }
}

// ---- WebSocket: each connection is a subscriber to sessionManager --------
wss.on('connection', (ws) => {
  function send(obj) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }

  // Forward sessionManager events to THIS socket.
  const onData = ({ id, data }) => send({ type: 'data', id, data });
  const onSession = ({ session }) => send({ type: 'session', session });
  const onClosed = ({ id }) => send({ type: 'closed', id });
  const onIdle = ({ id, title, preview }) => send({ type: 'idle', id, title, preview });
  // A restore replaces the whole session list; push the new one to every tab.
  const onReloaded = ({ sessions: list }) => send({ type: 'sessions', sessions: list });
  sessions.on('data', onData);
  sessions.on('session', onSession);
  sessions.on('closed', onClosed);
  sessions.on('idle', onIdle);
  sessions.on('reloaded', onReloaded);

  // Tell the tab what it's connected to. Sent unprompted because it can't
  // change while this process lives — a reconnect after an update restart
  // brings the new value with it.
  send(BUILD);

  // Reply with the current config (normalized shape from config.js).
  function sendConfig() {
    send(configPayload());
  }

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {
      case 'list':
        send({ type: 'sessions', sessions: sessions.list() });
        break;

      case 'create': {
        const session = sessions.create(msg.cwd, msg.cols, msg.rows);
        send({ type: 'created', session });
        break;
      }

      case 'attach':
        // Replay scrollback to ONLY this socket, then live data flows via the
        // 'data' subscription above.
        sessions.attach(msg.id, msg.cols, msg.rows, (buffer) => {
          send({ type: 'data', id: msg.id, data: buffer });
        });
        break;

      case 'input':
        sessions.input(msg.id, msg.data);
        break;

      case 'resize':
        sessions.resize(msg.id, msg.cols, msg.rows);
        break;

      case 'setcwd':
        sessions.setCwd(msg.id, msg.cwd, msg.cols, msg.rows);
        break;

      case 'restart':
        sessions.restart(msg.id, msg.cols, msg.rows);
        break;

      case 'resume':
        sessions.resume(msg.id, msg.cols, msg.rows);
        break;

      case 'close':
        sessions.close(msg.id);
        break;

      case 'getconfig':
        sendConfig();
        break;

      case 'saveconfig': {
        // Merge the incoming patch onto the persisted config, save, and broadcast
        // the updated config to every connected client.
        const cfg = loadConfig();
        if ('repoUrl' in msg) cfg.repoUrl = msg.repoUrl || '';
        if ('branch' in msg) cfg.branch = msg.branch || '';
        if ('autoSync' in msg) cfg.autoSync = !!msg.autoSync;
        if ('autoResume' in msg) cfg.autoResume = !!msg.autoResume;
        if ('recents' in msg) cfg.recents = Array.isArray(msg.recents) ? msg.recents : [];
        if ('pinned' in msg) cfg.pinned = Array.isArray(msg.pinned) ? msg.pinned : [];
        if ('syncWorkDir' in msg) cfg.syncWorkDir = msg.syncWorkDir || '';
        if ('syncRepos' in msg) cfg.syncRepos = Array.isArray(msg.syncRepos) ? msg.syncRepos : [];
        saveConfig(cfg);
        // Keep every open tab in sync.
        broadcastConfig();
        break;
      }

      case 'gitdiff': {
        const s = sessions.sessions.get(msg.id);
        if (!s) break;
        try {
          const result = await gitDiff(s.cwd);
          send({ type: 'gitdiff', id: msg.id, ...result });
        } catch (err) {
          send({ type: 'gitdiff', id: msg.id, ok: false, isRepo: false, files: [], patch: '', error: err.message });
        }
        break;
      }

      case 'sync': {
        // Sync the session's folder; stream output bracketed by start/done.
        const s = sessions.sessions.get(msg.id);
        if (!s) break;
        send({ type: 'syncstart', id: msg.id });
        const r = await syncRepo(s.cwd, d => send({ type: 'synclog', id: msg.id, data: d }));
        send({ type: 'syncdone', id: msg.id, ok: r.ok, message: r.message });
        break;
      }

      case 'syncall': {
        // Workspace-level sync (not scoped to a session): clone/pull the
        // configured list of repos into their own subfolders of syncWorkDir.
        // Modeled on the 'sync'/'update' handlers above, but for many repos
        // at once instead of one session's cwd or the app's own root.
        const cfg = loadConfig();
        send({ type: 'syncallstart' });
        const r = await syncAllRepos(cfg.syncWorkDir, cfg.syncRepos, d => send({ type: 'syncalllog', data: d }));
        send({ type: 'syncalldone', ok: r.ok, message: r.message });
        break;
      }

      case 'backupplan': {
        // What a backup would contain, so the UI can show the size before
        // someone copies hundreds of megabytes onto a USB stick.
        try {
          send({ type: 'backupplan', ok: true, ...(await planBackup()) });
        } catch (err) {
          send({ type: 'backupplan', ok: false, message: err.message });
        }
        break;
      }

      case 'backup': {
        // Read-only with respect to this app's live state, so it's safe to run
        // with sessions open — unlike restore.
        send({ type: 'backupstart' });
        try {
          // Async since a .zip destination streams the whole thing through a
          // compressor rather than just copying files.
          const r = await createBackup(msg.dest, { includeTranscripts: msg.includeTranscripts !== false });
          send({
            type: 'backupdone', ok: r.ok, message: r.message,
            totalBytes: r.totalBytes || 0, bytes: r.bytes || 0, zipped: !!r.zipped,
            // May differ from what was requested: a folder destination gets a
            // dated .zip inside it, so the UI has to be able to say where.
            dest: r.dest || '',
          });
        } catch (err) {
          send({ type: 'backupdone', ok: false, message: err.message });
        }
        break;
      }

      case 'restoreplan': {
        // Dry run: says what would land where, what it would clone, and which
        // sessions would be dropped because their folder isn't on this machine.
        try {
          const r = await restoreBackup(msg.src, {
            workDir: msg.workDir, remap: msg.remap, dryRun: true,
          });
          send({ type: 'restoreplan', ...r });
        } catch (err) {
          send({ type: 'restoreplan', ok: false, message: err.message });
        }
        break;
      }

      case 'restore': {
        // Restore replaces config.json and sessions.json wholesale. The running
        // sessionManager owns those files, so afterwards it has to re-read them
        // or its stale in-memory list would overwrite the restore on the next
        // change. reloadFromDisk() refuses while anything is live, which is also
        // the honest guard here: you can't swap the session list out from under
        // a running pty.
        const live = sessions.activeSessions();
        if ((live.busy.length || live.idle.length) && !msg.force) {
          const names = [...live.busy, ...live.idle].map(s => s.title).join(', ');
          send({
            type: 'restoredone', ok: false,
            message: `Close or stop the running sessions first (${names}). ` +
              `A restore replaces the whole session list, so nothing can be running.`,
          });
          break;
        }
        send({ type: 'restorestart' });
        try {
          // A workDir restore clones every project, which takes minutes — stream
          // progress the same way `update` does rather than leaving the UI blank.
          const r = await restoreBackup(msg.src, {
            workDir: msg.workDir,
            remap: msg.remap,
            onLog: (data) => send({ type: 'restorelog', data }),
          });
          let reloaded = false;
          if (r.ok) {
            // A restore rewrites config.json as well as sessions.json — the
            // repo list, workspace root and recents all change, and every one
            // of those is remapped to this machine's paths. Without this, tabs
            // keep the pre-restore config and show an empty Workspace Repos
            // list, then push that emptiness back over the restored file on
            // their next save.
            broadcastConfig();
            const rl = sessions.reloadFromDisk();
            reloaded = rl.ok;
            if (!rl.ok) r.log = [...(r.log || []), `could not reload sessions: ${rl.reason} — restart to pick them up`];
          }
          send({ type: 'restoredone', ok: r.ok, message: r.message, log: r.log || [], reloaded });
        } catch (err) {
          send({ type: 'restoredone', ok: false, message: err.message });
        }
        break;
      }

      case 'update': {
        // App-level self-update (not scoped to a session): pull the app's own
        // repo, npm install + build, stream output bracketed by start/done, then
        // — only on full success — restart this server process. Modeled on the
        // 'sync' handler above, but against the app's own root, not a session's cwd.
        // A restart kills every live pty, so a session mid-turn can lose the
        // reply it was streaming. The client warns about that before confirming
        // and sets `force` once the user has seen the warning. Re-check here
        // anyway: the dialog is a snapshot, and a session can start working
        // between the user reading it and clicking Update.
        const active = sessions.activeSessions();
        if (active.busy.length && !msg.force) {
          const names = active.busy.map(s => s.title).join(', ');
          const plural = active.busy.length > 1;
          send({
            type: 'updatedone',
            ok: false,
            restarting: false,
            // Recoverable, not a dead end. The client decides `force` from its own
            // view of who's busy, which it learns by broadcast — so it can disagree
            // with this check, and in a session that IS the app being updated
            // (the normal case for this app) that disagreement made the updater
            // unusable: a refusal with no way forward. Hand back the busy list and
            // a flag so the UI can re-confirm in one click.
            needsForce: true,
            busy: active.busy,
            message: `${names} ${plural ? 'are' : 'is'} working right now. ` +
              `Updating restarts the server and will cut ${plural ? 'them' : 'it'} off mid-turn.`,
          });
          break;
        }

        send({ type: 'updatestart' });
        const r = await runUpdate(d => send({ type: 'updatelog', data: d }));
        const restarting = !!(r.ok && r.shouldRestart);
        // url/latest are set only by the packaged path, which checks the release
        // feed instead of rewriting the install. The panel renders them as a real
        // download button — leaving the link buried in the log was the whole
        // reason that path looked like it had hung.
        send({
          type: 'updatedone',
          ok: r.ok, message: r.message, restarting,
          url: r.url || '', latest: r.latest || '',
        });
        if (restarting) {
          // Give the client a moment to receive 'updatedone' before the socket drops.
          setTimeout(() => {
            try {
              spawn(process.execPath, [path.join(__dirname, 'index.js')], {
                cwd: path.join(__dirname, '..'),
                detached: true,
                stdio: 'ignore',
                env: process.env,
              }).unref();
            } catch {}
            shutdown();
          }, 500);
        }
        break;
      }

      case 'image': {
        // Save a pasted image under the SESSION's cwd, then type its path in.
        const s = sessions.sessions.get(msg.id);
        if (!s) break;
        try {
          const dir = path.join(s.cwd, '.claude-web-images');
          fs.mkdirSync(dir, { recursive: true });
          const ext = (msg.ext || 'png').replace(/[^a-z0-9]/gi, '');
          const file = path.join(dir, `paste-${Date.now()}.${ext}`);
          const b64 = String(msg.data).replace(/^data:[^,]+,/, '');
          fs.writeFileSync(file, Buffer.from(b64, 'base64'));
          // Inject the path (quoted) plus a trailing space.
          sessions.input(msg.id, `"${file}" `);
        } catch (err) {
          send({ type: 'data', id: msg.id, data: `\r\n\x1b[31m[image save failed: ${err.message}]\x1b[0m\r\n` });
        }
        break;
      }

      case 'file': {
        // Save an attached document under the SESSION's cwd, keeping its real
        // name, then type its path in so Claude can read/analyze it.
        const s = sessions.sessions.get(msg.id);
        if (!s) break;
        try {
          const dir = path.join(s.cwd, '.claude-web-files');
          fs.mkdirSync(dir, { recursive: true });
          let name = path.basename(String(msg.name || 'file')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
          if (!name) name = 'file';
          let file = path.join(dir, name);
          if (fs.existsSync(file)) { // avoid clobbering: name-<timestamp>.ext
            const ext = path.extname(name);
            file = path.join(dir, `${path.basename(name, ext)}-${Date.now()}${ext}`);
          }
          const b64 = String(msg.data).replace(/^data:[^,]+,/, '');
          fs.writeFileSync(file, Buffer.from(b64, 'base64'));
          sessions.input(msg.id, `"${file}" `);
        } catch (err) {
          send({ type: 'data', id: msg.id, data: `\r\n\x1b[31m[attach failed: ${err.message}]\x1b[0m\r\n` });
        }
        break;
      }
    }
  });

  // On disconnect, just unsubscribe — DO NOT kill sessions (persistence is the point).
  ws.on('close', () => {
    sessions.off('data', onData);
    sessions.off('session', onSession);
    sessions.off('closed', onClosed);
    sessions.off('idle', onIdle);
    sessions.off('reloaded', onReloaded);
  });
});

// Rehydrate any sessions left open when the server last shut down. They come
// back as 'stopped' ghosts; the user resumes them (with prior context) on demand.
const restored = sessions.restore();

// Self-update spawns the new process before the old one has necessarily
// released the port (see 'update' handler above), so a fresh EADDRINUSE is
// expected, not exceptional — retry briefly instead of crashing unhandled.
let listenRetries = 0;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && listenRetries < 20) {
    listenRetries++;
    setTimeout(() => server.listen(PORT, HOST), 250);
  } else {
    console.error(`\n  Failed to start: ${err.message}\n`);
    process.exit(1);
  }
});
server.on('listening', () => {
  try { fs.writeFileSync(PID_PATH, String(process.pid)); } catch {}
  console.log(`\n  Claude Code Web UI v2 running:  http://${HOST}:${PORT}\n`);
  console.log(`  Claude launcher: ${CLAUDE}`);
  console.log(`  Static UI: ${fs.existsSync(distDir) ? distDir : '(dev — served by Vite)'}`);
  console.log(`  Restored sessions: ${restored}\n`);
});
server.listen(PORT, HOST);

// Graceful shutdown: kill every pty, drop the pidfile, then exit.
function shutdown() {
  try { sessions.killAll(); } catch {}
  try { fs.unlinkSync(PID_PATH); } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
