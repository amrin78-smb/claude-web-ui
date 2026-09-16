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
    res.json(listDir(req.query.path, defaultCwd()));
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

  // Reply with the current config (normalized shape from config.js).
  function sendConfig() {
    const cfg = loadConfig();
    send({
      type: 'config',
      repoUrl: cfg.repoUrl || '',
      branch: cfg.branch || '',
      autoSync: !!cfg.autoSync,
      recents: cfg.recents || [],
      pinned: cfg.pinned || [],
      syncWorkDir: cfg.syncWorkDir || '',
      syncRepos: cfg.syncRepos || [],
    });
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
        if ('recents' in msg) cfg.recents = Array.isArray(msg.recents) ? msg.recents : [];
        if ('pinned' in msg) cfg.pinned = Array.isArray(msg.pinned) ? msg.pinned : [];
        if ('syncWorkDir' in msg) cfg.syncWorkDir = msg.syncWorkDir || '';
        if ('syncRepos' in msg) cfg.syncRepos = Array.isArray(msg.syncRepos) ? msg.syncRepos : [];
        saveConfig(cfg);
        const payload = {
          type: 'config',
          repoUrl: cfg.repoUrl || '',
          branch: cfg.branch || '',
          autoSync: !!cfg.autoSync,
          recents: cfg.recents || [],
          pinned: cfg.pinned || [],
          syncWorkDir: cfg.syncWorkDir || '',
          syncRepos: cfg.syncRepos || [],
        };
        // Broadcast to all clients so every open tab stays in sync.
        for (const client of wss.clients) {
          if (client.readyState === client.OPEN) client.send(JSON.stringify(payload));
        }
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
          send({ type: 'backupplan', ok: true, ...planBackup() });
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
          const r = createBackup(msg.dest, { includeTranscripts: msg.includeTranscripts !== false });
          send({ type: 'backupdone', ok: r.ok, message: r.message, totalBytes: r.totalBytes || 0 });
        } catch (err) {
          send({ type: 'backupdone', ok: false, message: err.message });
        }
        break;
      }

      case 'restoreplan': {
        // Dry run: says what would land where, and which sessions would be
        // dropped because their folder isn't on this machine.
        try {
          const r = await restoreBackup(msg.src, { remap: msg.remap, dryRun: true });
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
          const r = await restoreBackup(msg.src, { remap: msg.remap });
          let reloaded = false;
          if (r.ok) {
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
            message: `${names} started working while the confirmation was open. ` +
              `Nothing was changed — try again once ${plural ? 'they are' : 'it is'} finished.`,
          });
          break;
        }

        send({ type: 'updatestart' });
        const r = await runUpdate(d => send({ type: 'updatelog', data: d }));
        const restarting = !!(r.ok && r.shouldRestart);
        send({ type: 'updatedone', ok: r.ok, message: r.message, restarting });
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
