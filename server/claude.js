/* Locate the Claude Code launcher and spawn it inside a real PTY.
 *
 * Ports findClaude()/WEB_SYSTEM_PROMPT and the spawn options from the old
 * single-session server.js, generalized into a reusable spawnClaude() helper.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const pty = require('@lydell/node-pty');

// ---- locate the Claude CLI launcher -------------------------------------
function findClaude() {
  // 1) Common global-npm location on Windows.
  const npmGlobal = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'claude.cmd');
  if (fs.existsSync(npmGlobal)) return npmGlobal;

  // 2) Native installer location (curl-installed, not npm-global) — produces
  // claude.exe on Windows / a claude symlink elsewhere, no .cmd shim.
  const localBin = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  if (fs.existsSync(localBin)) return localBin;

  // 3) Ask the shell to resolve it via PATH. Use the bare name (not "claude.cmd")
  // so Windows `where` matches any extension in PATHEXT, e.g. claude.exe.
  try {
    const cmd = process.platform === 'win32' ? 'where claude' : 'which claude';
    const out = execSync(cmd, { encoding: 'utf8' });
    const lines = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (process.platform === 'win32') {
      // npm global installs drop an extensionless POSIX shell shim (#!/bin/sh)
      // alongside claude.cmd/.exe for cross-platform use. `where` can list that
      // shim first, and CreateProcess can't execute it (error 193). Only accept
      // matches with a real Windows executable extension.
      const winExe = lines.find(l => /\.(cmd|exe|bat)$/i.test(l));
      if (winExe && fs.existsSync(winExe)) return winExe;
    } else if (lines[0] && fs.existsSync(lines[0])) {
      return lines[0];
    }
  } catch {}

  if (process.platform !== 'win32') {
    // 4) Where the other installers put it. Matters because the server usually
    // runs as a systemd user service or from a desktop launcher, whose PATH is
    // the bare system one: an npm-global or nvm install is invisible to `which`
    // there, and the session dies with node-pty's "execvp(3) failed".
    const home = os.homedir();
    const known = [
      path.join(home, '.claude', 'local', 'claude'),
      path.join(home, '.npm-global', 'bin', 'claude'),
      path.join(home, '.bun', 'bin', 'claude'),
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
    ];
    try {
      const nvm = path.join(home, '.nvm', 'versions', 'node');
      for (const v of fs.readdirSync(nvm).sort().reverse()) known.push(path.join(nvm, v, 'bin', 'claude'));
    } catch {}
    const hit = known.find(p => fs.existsSync(p));
    if (hit) return hit;

    // 5) The user's login shell knows their real PATH (nvm, custom prefixes).
    try {
      const out = execSync(`${process.env.SHELL || '/bin/sh'} -lc 'command -v claude'`,
        { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      const line = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean).pop();
      if (line && path.isAbsolute(line) && fs.existsSync(line)) return line;
    } catch {}
  }

  // 6) Bare name, let the shell resolve it at spawn time.
  return process.platform === 'win32' ? 'claude.cmd' : 'claude';
}

// Resolved once at load for the startup banner, and again at spawn time while
// it is still unresolved (or the file has gone): installing Claude after the
// server started should work from the next "Start Claude", not after a restart.
let CLAUDE = findClaude();
function resolveClaude() {
  if (!path.isAbsolute(CLAUDE) || !fs.existsSync(CLAUDE)) CLAUDE = findClaude();
  return CLAUDE;
}

// Whether a bare command name would resolve on this process's PATH.
function onPath(name) {
  return (process.env.PATH || '').split(path.delimiter).some(d => d && fs.existsSync(path.join(d, name)));
}

// Whether Claude can actually be launched right now — what the UI's
// "not installed" banner asks. Re-resolves, so it turns true as soon as the
// user installs Claude, without a server restart.
const INSTALL_COMMAND = process.platform === 'win32'
  ? 'irm https://claude.ai/install.ps1 | iex'
  : 'curl -fsSL https://claude.ai/install.sh | bash';
function claudeStatus() {
  const file = resolveClaude();
  const found = path.isAbsolute(file) ? fs.existsSync(file) : onPath(file);
  return { found, path: found ? file : null, install: INSTALL_COMMAND };
}

// Shown in the terminal instead of node-pty's "execvp(3) failed.: No such file
// or directory", which tells nobody what to do.
const NOT_FOUND = [
  '',
  '  \x1b[1;31mClaude Code CLI not found.\x1b[0m',
  '',
  '  This app runs the `claude` command, and it is not installed for this user',
  '  (or not anywhere the server can see). Install it in a terminal with:',
  '',
  '    \x1b[1mcurl -fsSL https://claude.ai/install.sh | bash\x1b[0m',
  '',
  '  then run `claude` once to sign in, and click Start Claude here.',
  '',
].join('\r\n');

// Scoped hint injected only into these web sessions (not global, not per-repo).
// Copied VERBATIM from old server.js lines 25-36.
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

// This app's node_modules — prepended to NODE_PATH so scripts Claude writes can
// `require('pptxgenjs')` from ANY working folder without installing it.
const appNodeModules = path.join(__dirname, '..', 'node_modules');

// Claude Code stores each folder's conversation transcripts under
// ~/.claude/projects/<slug>, where <slug> is the absolute cwd with every
// non-alphanumeric char replaced by '-' (e.g. C:\Users\me\app -> C--Users-me-app).
function claudeProjectDir(cwd) {
  const slug = String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', slug);
}

// True if Claude has at least one saved conversation (*.jsonl) for this folder,
// i.e. `claude --continue` has something real to resume.
function hasClaudeHistory(cwd) {
  try {
    const dir = claudeProjectDir(cwd);
    if (!fs.existsSync(dir)) return false;
    return fs.readdirSync(dir).some(f => f.endsWith('.jsonl'));
  } catch {
    return false;
  }
}

// Spawn Claude Code in `cwd` at the given terminal size. Returns the pty.
// `opts.resume` adds `--continue`, which reopens the most recent conversation
// in that folder instead of starting a fresh one — the "session memory" path.
function spawnClaude(cwd, cols = 120, rows = 30, opts = {}) {
  const nodePath = [appNodeModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
  const args = ['--dangerously-skip-permissions', '--append-system-prompt', WEB_SYSTEM_PROMPT];
  if (opts.resume) args.unshift('--continue');
  let file = resolveClaude();
  if (process.platform !== 'win32' && !path.isAbsolute(file) && !onPath(file)) {
    // Through the same pty, so the session's normal exit handling shows it.
    file = '/bin/sh';
    args.length = 0;
    args.push('-c', 'printf "%s\\r\\n" "$0"; exit 127', NOT_FOUND);
  }
  return pty.spawn(
    file,
    args,
    {
      name: 'xterm-color',
      cols,
      rows,
      cwd,
      env: { ...process.env, FORCE_COLOR: '3', NODE_PATH: nodePath },
    }
  );
}

module.exports = { get CLAUDE() { return CLAUDE; }, claudeStatus, WEB_SYSTEM_PROMPT, spawnClaude, findClaude, hasClaudeHistory, claudeProjectDir };
