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

  // 4) Bare name, let the shell resolve it at spawn time.
  return process.platform === 'win32' ? 'claude.cmd' : 'claude';
}

const CLAUDE = findClaude();

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
  'Before any non-trivial multi-step task, apply the fable-method loop.',
  'After substantive work, run fable-judge before presenting as finished.',
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
  return pty.spawn(
    CLAUDE,
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

module.exports = { CLAUDE, WEB_SYSTEM_PROMPT, spawnClaude, findClaude, hasClaudeHistory, claudeProjectDir };
