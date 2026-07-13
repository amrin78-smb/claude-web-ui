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
const { syncRepo, gitDiff } = require('./git');
const { runUpdate } = require('./update');
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
const wss = new WebSocketServer({ server, path: '/ws' });

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
  sessions.on('data', onData);
  sessions.on('session', onSession);
  sessions.on('closed', onClosed);
  sessions.on('idle', onIdle);

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
        saveConfig(cfg);
        const payload = {
          type: 'config',
          repoUrl: cfg.repoUrl || '',
          branch: cfg.branch || '',
          autoSync: !!cfg.autoSync,
          recents: cfg.recents || [],
          pinned: cfg.pinned || [],
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

      case 'update': {
        // App-level self-update (not scoped to a session): pull the app's own
        // repo, npm install + build, stream output bracketed by start/done, then
        // — only on full success — restart this server process. Modeled on the
        // 'sync' handler above, but against the app's own root, not a session's cwd.
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
