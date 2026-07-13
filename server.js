/* Claude Code Web UI - local server
 *
 * Spawns Claude Code inside a real pseudo-terminal (ConPTY on Windows) and
 * streams it to a browser terminal over a WebSocket. Also lets the browser:
 *   - change the working folder (respawns Claude there)
 *   - browse folders on disk (so you don't have to type full paths)
 *   - paste images, which are saved to disk and their path injected into the prompt
 *
 * Everything stays on localhost. Nothing is sent anywhere except to Claude Code
 * running on this machine.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const pty = require('@lydell/node-pty');
const { execSync, spawn } = require('child_process');

const PORT = process.env.PORT || 4280;
const HOST = '127.0.0.1';

// Scoped hint injected only into these web sessions (not global, not per-repo).
const WEB_SYSTEM_PROMPT = [
  'You are running through a local web UI.',
  'Files the user attaches in the page are saved to a `.claude-web-files/` folder',
  '(images to `.claude-web-images/`) inside the current working directory, and their',
  'full paths are typed into your prompt automatically — read/analyze them from there.',
  'For .xlsx/.docx/.csv you may write and run a short script to parse them.',
  'To create PowerPoint (.pptx) files, the Node library `pptxgenjs` is already installed',
  'and resolvable (NODE_PATH is set), so write a Node script using',
  "`require('pptxgenjs')` and run it with `node` — no install needed. Save outputs in",
  'the current working directory.',
].join(' ');

// ---- locate the Claude CLI launcher -------------------------------------
function findClaude() {
  // 1) Common global-npm location on Windows.
  const npmGlobal = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'claude.cmd');
  if (fs.existsSync(npmGlobal)) return npmGlobal;

  // 2) Ask the shell to resolve it via PATH.
  try {
    const cmd = process.platform === 'win32' ? 'where claude.cmd' : 'which claude';
    const out = execSync(cmd, { encoding: 'utf8' });
    const line = out.split(/\r?\n/).map(s => s.trim()).find(Boolean);
    if (line && fs.existsSync(line)) return line;
  } catch {}

  // 3) Bare name, let the shell resolve it at spawn time.
  return process.platform === 'win32' ? 'claude.cmd' : 'claude';
}
const CLAUDE = findClaude();

// ---- persistent config ---------------------------------------------------
const CONFIG_PATH = path.join(__dirname, 'config.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(c) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
  } catch (err) {
    console.error('failed to save config:', err.message);
  }
}

// Module-level config, shared across connections.
const config = loadConfig();

// Default working folder: saved config, then env/cwd, then the user's home.
let currentCwd;
if (config.cwd && fs.existsSync(config.cwd)) {
  currentCwd = config.cwd;
} else {
  currentCwd = process.env.CLAUDE_WEB_CWD || process.cwd();
  if (!fs.existsSync(currentCwd)) currentCwd = os.homedir();
}

// ---- git sync ------------------------------------------------------------
// Run a git command, streaming both stdout and stderr to onData. Resolves with
// { code }. Never rejects. GIT_TERMINAL_PROMPT=0 makes git fail (not hang) when
// credentials are missing.
function runGit(args, cwd, onData) {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    child.stdout.on('data', d => onData(d.toString()));
    child.stderr.on('data', d => onData(d.toString())); // git writes progress here
    child.on('error', (err) => {
      onData('git error: ' + err.message + '\n');
      resolve({ code: -1 });
    });
    child.on('close', (code) => resolve({ code }));
  });
}

// Clone (into an empty folder) or pull (into an existing repo) the configured
// GitHub repo. Streams output via onData. Resolves with { ok, message }.
async function syncRepo(cwd, onData) {
  if (!config.repoUrl) {
    onData('No GitHub repo configured. Set one in Settings.\n');
    return { ok: false, message: 'no repo configured' };
  }

  const isRepo = fs.existsSync(path.join(cwd, '.git'));

  if (!isRepo) {
    // Only clone into an empty (or non-existent) folder.
    const isEmpty = fs.existsSync(cwd)
      ? fs.readdirSync(cwd).filter(n => n !== '.claude-web-images').length === 0
      : true;
    if (!isEmpty) {
      onData(
        "Can't clone into a non-empty folder that isn't already a git repo.\n" +
        'Choose an empty folder, or open a folder that already contains the repo.\n'
      );
      return { ok: false, message: 'folder not empty' };
    }
    fs.mkdirSync(cwd, { recursive: true });
    onData(`Cloning ${config.repoUrl} ...\n`);
    const args = ['clone', ...(config.branch ? ['--branch', config.branch] : []), config.repoUrl, cwd];
    const { code } = await runGit(args, path.dirname(cwd), onData);
    return { ok: code === 0, message: code === 0 ? 'cloned' : 'clone failed' };
  }

  // Existing repo: pull latest.
  onData('Fetching + pulling latest...\n');
  const { code } = await runGit(['pull', '--ff-only'], cwd, onData);
  if (code !== 0) {
    onData(
      'Pull failed (local changes or a non-fast-forward).\n' +
      'Resolve the issue in this folder, then sync again.\n'
    );
  }
  return { ok: code === 0, message: code === 0 ? 'up to date' : 'pull failed' };
}

// ---- HTTP / static -------------------------------------------------------
const app = express();
app.use(express.json({ limit: '64mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Serve the xterm assets straight from node_modules so it works offline.
app.use('/vendor/xterm', express.static(path.join(__dirname, 'node_modules', '@xterm', 'xterm', 'lib')));
app.use('/vendor/xterm-css', express.static(path.join(__dirname, 'node_modules', '@xterm', 'xterm', 'css')));
app.use('/vendor/addon-fit', express.static(path.join(__dirname, 'node_modules', '@xterm', 'addon-fit', 'lib')));
app.use('/vendor/addon-web-links', express.static(path.join(__dirname, 'node_modules', '@xterm', 'addon-web-links', 'lib')));

// List drives + immediate subfolders for the folder browser.
app.get('/api/dirs', (req, res) => {
  const target = req.query.path ? String(req.query.path) : currentCwd;
  try {
    if (target === '__drives__') {
      // On Windows enumerate drive letters; elsewhere just use root.
      const drives = [];
      if (process.platform === 'win32') {
        for (let i = 67; i <= 90; i++) { // C..Z
          const letter = String.fromCharCode(i) + ':\\';
          if (fs.existsSync(letter)) drives.push({ name: letter, path: letter });
        }
      } else {
        drives.push({ name: '/', path: '/' });
      }
      return res.json({ path: '__drives__', parent: null, dirs: drives });
    }
    const abs = path.resolve(target);
    const entries = fs.readdirSync(abs, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .filter(d => !d.name.startsWith('$')) // hide windows system junk
      .map(d => ({ name: d.name, path: path.join(abs, d.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const parent = path.dirname(abs);
    res.json({
      path: abs,
      parent: parent === abs ? '__drives__' : parent,
      dirs: entries,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ---- one Claude session per WebSocket connection -------------------------
wss.on('connection', (ws) => {
  let term = null;
  let cwd = currentCwd;

  function send(obj) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }

  // Send the current config + working folder to the client.
  function sendConfig() {
    send({
      type: 'config',
      repoUrl: config.repoUrl || '',
      branch: config.branch || '',
      autoSync: !!config.autoSync,
      cwd,
    });
  }

  // Optionally sync the repo into cwd, then launch Claude. When doSync is set
  // and auto-sync is enabled with a repo configured, the sync runs (streaming
  // its output) before Claude starts.
  async function startSession(cols, rows, doSync) {
    if (doSync && config.autoSync && config.repoUrl) {
      send({ type: 'syncstart' });
      send({ type: 'status', text: 'syncing…' });
      const r = await syncRepo(cwd, d => send({ type: 'synclog', data: d }));
      send({ type: 'syncdone', ok: r.ok, message: r.message });
    }
    startClaude(cols, rows);
  }

  function startClaude(cols = 120, rows = 30) {
    if (term) { try { term.kill(); } catch {} term = null; }
    if (!fs.existsSync(cwd)) cwd = os.homedir();
    currentCwd = cwd;

    send({ type: 'cwd', path: cwd });
    send({ type: 'status', text: 'starting Claude Code…' });

    let thisTerm;
    try {
      // NODE_PATH points at this app's node_modules so scripts Claude writes can
      // `require('pptxgenjs')` from ANY working folder without installing it.
      const appModules = path.join(__dirname, 'node_modules');
      const nodePath = [appModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
      thisTerm = pty.spawn(CLAUDE, ['--dangerously-skip-permissions', '--append-system-prompt', WEB_SYSTEM_PROMPT], {
        name: 'xterm-color',
        cols, rows,
        cwd,
        env: { ...process.env, FORCE_COLOR: '3', NODE_PATH: nodePath },
      });
    } catch (err) {
      send({ type: 'data', data: `\r\n[failed to launch Claude: ${err.message}]\r\n` });
      return;
    }
    term = thisTerm;

    // Guard both handlers against the previous PTY: when we change folder/restart
    // we kill the old PTY, but its exit/data events fire asynchronously — AFTER the
    // new PTY is already assigned to `term`. Without this `term === thisTerm` check,
    // the dead PTY's onExit would run `term = null`, clobbering the live terminal so
    // typed input is silently dropped (and a stray "[Claude exited]" banner shows).
    thisTerm.onData(d => { if (term === thisTerm) send({ type: 'data', data: d }); });
    thisTerm.onExit(({ exitCode }) => {
      if (term !== thisTerm) return; // a newer session replaced this one; ignore.
      send({ type: 'data', data: `\r\n\x1b[33m[Claude exited (code ${exitCode}). Click "Restart Claude" to start again.]\x1b[0m\r\n` });
      send({ type: 'status', text: 'stopped' });
      term = null;
    });
    send({ type: 'status', text: 'running' });
  }

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {
      case 'start':
        cwd = msg.cwd && fs.existsSync(msg.cwd) ? msg.cwd : cwd;
        // Populate the UI with config first, then auto-sync on first open.
        sendConfig();
        await startSession(msg.cols, msg.rows, true);
        break;

      case 'input':
        if (term) term.write(msg.data);
        break;

      case 'resize':
        if (term) { try { term.resize(msg.cols, msg.rows); } catch {} }
        break;

      case 'setcwd': // change folder + relaunch Claude there
        if (msg.cwd && fs.existsSync(msg.cwd)) {
          cwd = msg.cwd;
          // Persist the chosen folder, then sync into it before launching.
          config.cwd = cwd;
          saveConfig(config);
          await startSession(msg.cols, msg.rows, true);
        } else {
          send({ type: 'status', text: 'folder not found' });
        }
        break;

      case 'restart':
        await startSession(msg.cols, msg.rows, false);
        break;

      case 'getconfig':
        sendConfig();
        break;

      case 'saveconfig':
        config.repoUrl = msg.repoUrl || '';
        config.branch = msg.branch || '';
        config.autoSync = !!msg.autoSync;
        saveConfig(config);
        sendConfig();
        break;

      case 'sync': { // sync the current folder, do NOT restart Claude
        send({ type: 'syncstart' });
        const r = await syncRepo(cwd, d => send({ type: 'synclog', data: d }));
        send({ type: 'syncdone', ok: r.ok, message: r.message });
        break;
      }

      case 'image': {
        // Save a pasted image next to the project, then type its path into Claude.
        try {
          const dir = path.join(cwd, '.claude-web-images');
          fs.mkdirSync(dir, { recursive: true });
          const ext = (msg.ext || 'png').replace(/[^a-z0-9]/gi, '');
          const file = path.join(dir, `paste-${Date.now()}.${ext}`);
          const b64 = String(msg.data).replace(/^data:[^,]+,/, '');
          fs.writeFileSync(file, Buffer.from(b64, 'base64'));
          // Inject the path (quoted) plus a trailing space; user can add text + Enter.
          if (term) term.write(`"${file}" `);
          send({ type: 'status', text: `image saved → ${path.basename(file)}` });
        } catch (err) {
          send({ type: 'status', text: `image save failed: ${err.message}` });
        }
        break;
      }

      case 'file': {
        // Save an attached document (xlsx/pdf/docx/csv/…) keeping its real name,
        // then type its path into Claude so it can read/analyze it.
        try {
          const dir = path.join(cwd, '.claude-web-files');
          fs.mkdirSync(dir, { recursive: true });
          // Sanitize the original filename; keep it readable for Claude's context.
          let name = path.basename(String(msg.name || 'file')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
          if (!name) name = 'file';
          let file = path.join(dir, name);
          if (fs.existsSync(file)) { // avoid clobbering: name-<timestamp>.ext
            const ext = path.extname(name);
            file = path.join(dir, `${path.basename(name, ext)}-${Date.now()}${ext}`);
          }
          const b64 = String(msg.data).replace(/^data:[^,]+,/, '');
          fs.writeFileSync(file, Buffer.from(b64, 'base64'));
          if (term) term.write(`"${file}" `);
          send({ type: 'status', text: `attached → ${path.basename(file)}` });
        } catch (err) {
          send({ type: 'status', text: `attach failed: ${err.message}` });
        }
        break;
      }
    }
  });

  ws.on('close', () => { if (term) { try { term.kill(); } catch {} } });
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Claude Code Web UI running:  http://${HOST}:${PORT}\n`);
  console.log(`  Working folder: ${currentCwd}`);
  console.log(`  Claude launcher: ${CLAUDE}\n`);
});
