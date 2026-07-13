/* SessionManager — persistent, multi-session PTY manager.
 *
 * Holds a Map<id, {pty, cwd, title, status, buffer}>. PTYs live HERE, not tied
 * to any WebSocket, so they survive page reloads. Subscribers (WebSockets) listen
 * on an EventEmitter for 'data' | 'session' | 'closed' and replay scrollback on
 * attach.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { spawnClaude, hasClaudeHistory } = require('./claude');
const { readUsage } = require('./usage');

// Scrollback cap per session (~256 KB). On overflow we trim from the front so
// the most recent output is always retained.
const BUFFER_CAP = 256 * 1024;

// How long pty output must be quiet before we consider a session idle again.
const IDLE_MS = 1500;

// Strip ANSI escapes and return the last non-empty line of a buffer, for the
// "finished" notification preview.
function lastLine(buffer) {
  const clean = String(buffer || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const lines = clean.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const line = lines[lines.length - 1] || '';
  return line.length > 120 ? line.slice(0, 120) + '…' : line;
}

// Where the open-session list is persisted so it survives a SERVER restart (not
// just a page reload). We store only metadata (id/cwd/title) — never the live
// pty — and rehydrate them as 'stopped' ghosts the user can resume.
const SESSIONS_PATH = path.join(__dirname, '..', 'sessions.json');

class SessionManager extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, {pty:any, cwd:string, title:string, status:string, buffer:string}>} */
    this.sessions = new Map();
  }

  // Serialize a session for the wire (no pty/buffer). `resumable` tells the UI a
  // prior Claude conversation exists for this folder that `--continue` can reopen.
  // `busy` is true while output is actively streaming since the user's last
  // prompt; `usage`/`preview` are refreshed each time a session goes idle.
  _wire(s) {
    return {
      id: s.id, cwd: s.cwd, title: s.title, status: s.status, resumable: !!s.resumable,
      busy: !!s.busy, usage: s.usage || null, preview: s.preview || '',
    };
  }

  // List all sessions as wire objects.
  list() {
    return [...this.sessions.values()].map(s => this._wire(s));
  }

  // Persist the current open-session list (metadata only) to disk.
  _persist() {
    try {
      const data = [...this.sessions.values()].map(s => ({ id: s.id, cwd: s.cwd, title: s.title }));
      fs.writeFileSync(SESSIONS_PATH, JSON.stringify(data, null, 2));
    } catch {}
  }

  // Rehydrate persisted sessions as 'stopped' ghosts (no pty spawned). Marks each
  // resumable when Claude actually has saved history for that folder. Called once
  // at server startup; safe to call when sessions.json is missing/corrupt.
  restore() {
    let data = [];
    try { data = JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8')); } catch { data = []; }
    if (!Array.isArray(data)) return 0;
    for (const r of data) {
      if (!r || !r.id || !r.cwd) continue;
      if (this.sessions.has(r.id)) continue;
      if (!fs.existsSync(r.cwd)) continue; // folder is gone — drop it
      this.sessions.set(r.id, {
        id: r.id,
        cwd: r.cwd,
        title: r.title || path.basename(r.cwd) || r.cwd,
        status: 'stopped',
        buffer: '',
        pty: null,
        resumable: hasClaudeHistory(r.cwd),
        busy: false,
        usage: null,
        preview: '',
        _idleTimer: null,
        _sawInput: false,
      });
    }
    return this.sessions.size;
  }

  // Append output to a session's bounded buffer and broadcast it live. Also
  // drives busy/idle tracking: any output marks the session busy immediately;
  // once output has been quiet for IDLE_MS, it flips back to idle, refreshes
  // usage, and — if the user actually prompted it this round — emits 'idle'
  // for the completion-notification feature.
  _emitData(session, data) {
    session.buffer += data;
    if (session.buffer.length > BUFFER_CAP) {
      session.buffer = session.buffer.slice(session.buffer.length - BUFFER_CAP);
    }
    this.emit('data', { id: session.id, data });

    if (!session.busy) {
      session.busy = true;
      this._emitSession(session);
    }
    clearTimeout(session._idleTimer);
    session._idleTimer = setTimeout(() => this._goIdle(session), IDLE_MS);
  }

  // Transition a session from busy back to idle: refresh usage/preview and,
  // only if the user prompted it since the last idle, announce completion.
  _goIdle(session) {
    session.busy = false;
    session.usage = readUsage(session.cwd);
    session.preview = lastLine(session.buffer);
    this._emitSession(session);
    if (session._sawInput) {
      session._sawInput = false;
      this.emit('idle', { id: session.id, title: session.title, preview: session.preview });
    }
  }

  // Broadcast a session metadata change (status/cwd/title).
  _emitSession(session) {
    this.emit('session', { session: this._wire(session) });
  }

  // Wire up a freshly-spawned pty to a session. Captures `thisPty` locally so the
  // OLD pty's async onExit can't clobber a NEWER one after respawn (identity guard).
  _wirePty(session, thisPty) {
    session.pty = thisPty;
    session.status = 'running';

    thisPty.onData(d => {
      // Ignore late data from a pty that has since been replaced.
      if (session.pty !== thisPty) return;
      this._emitData(session, d);
    });

    thisPty.onExit(({ exitCode }) => {
      // CRITICAL: a newer pty replaced this one (setcwd/restart) — ignore the
      // dead pty's exit so we don't clobber the live session.
      if (session.pty !== thisPty) return;
      const notice = `\r\n\x1b[33m[Claude exited (code ${exitCode}). Click "Restart Claude" to start again.]\x1b[0m\r\n`;
      this._emitData(session, notice);
      clearTimeout(session._idleTimer);
      session.busy = false;
      session.status = 'stopped';
      // Recheck now that Claude has actually run — a transcript may exist even
      // though _spawn() unconditionally set resumable=false at launch time.
      session.resumable = hasClaudeHistory(session.cwd);
      // Do NOT delete the session — the user can restart it.
      this._emitSession(session);
    });
  }

  // Spawn (or respawn) Claude for a session in its current cwd. When `resume` is
  // set, launches with `--continue` to reopen the folder's last conversation.
  // Once a session has been spawned this run it's no longer a resumable ghost.
  _spawn(session, cols, rows, resume = false) {
    // Kill any existing pty first; its async onExit is harmless thanks to the guard.
    if (session.pty) { try { session.pty.kill(); } catch {} }
    if (!fs.existsSync(session.cwd)) session.cwd = os.homedir();

    clearTimeout(session._idleTimer);
    session.busy = false;
    session._sawInput = false;
    session.resumable = false;
    session.status = 'starting';
    this._emitSession(session);

    let thisPty;
    try {
      thisPty = spawnClaude(session.cwd, cols, rows, { resume });
    } catch (err) {
      const notice = `\r\n\x1b[31m[failed to launch Claude: ${err.message}]\x1b[0m\r\n`;
      this._emitData(session, notice);
      session.status = 'stopped';
      this._emitSession(session);
      return;
    }
    this._wirePty(session, thisPty);
    // 'starting' -> 'running' right after spawn.
    this._emitSession(session);
  }

  // Create a new session, spawn Claude in cwd, broadcast it. Returns wire object.
  create(cwd, cols = 120, rows = 30) {
    if (!cwd || !fs.existsSync(cwd)) cwd = os.homedir();
    const id = crypto.randomUUID();
    const session = {
      id,
      cwd,
      title: path.basename(cwd) || cwd,
      status: 'starting',
      buffer: '',
      pty: null,
      busy: false,
      usage: null,
      preview: '',
      _idleTimer: null,
      _sawInput: false,
    };
    this.sessions.set(id, session);
    this._spawn(session, cols, rows);
    this._persist();
    return this._wire(session);
  }

  // Attach a subscriber to a session: resize the pty to its viewport, then replay
  // the scrollback buffer to ONLY the requesting subscriber via `replay`.
  attach(id, cols, rows, replay) {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.pty && cols && rows) {
      try { session.pty.resize(cols, rows); } catch {}
    }
    if (typeof replay === 'function' && session.buffer) {
      replay(session.buffer);
    }
  }

  // Write keystrokes to a session's pty. A carriage return means the user
  // actually submitted a prompt, which is what gates the 'idle' (completion)
  // event — plain navigation/typing keystrokes should never trigger it.
  input(id, data) {
    const session = this.sessions.get(id);
    if (session && session.pty) {
      if (String(data).includes('\r')) session._sawInput = true;
      try { session.pty.write(data); } catch {}
    }
  }

  // Resize a session's pty.
  resize(id, cols, rows) {
    const session = this.sessions.get(id);
    if (session && session.pty && cols && rows) {
      try { session.pty.resize(cols, rows); } catch {}
    }
  }

  // Change a session's folder and respawn Claude there.
  setCwd(id, cwd, cols, rows) {
    const session = this.sessions.get(id);
    if (!session) return;
    if (!cwd || !fs.existsSync(cwd)) return; // ignore bad folders
    session.cwd = cwd;
    session.title = path.basename(cwd) || cwd;
    this._spawn(session, cols, rows);
    this._persist();
  }

  // Respawn Claude in the same folder (fresh conversation).
  restart(id, cols, rows) {
    const session = this.sessions.get(id);
    if (!session) return;
    this._spawn(session, cols, rows);
  }

  // Resume the folder's most recent Claude conversation (`--continue`). Used to
  // bring a restored ghost session back with its prior context intact.
  resume(id, cols, rows) {
    const session = this.sessions.get(id);
    if (!session) return;
    this._spawn(session, cols, rows, true);
  }

  // Kill the pty, drop the session, broadcast its removal.
  close(id) {
    const session = this.sessions.get(id);
    if (!session) return;
    clearTimeout(session._idleTimer);
    if (session.pty) {
      // Detach first so the dying pty's onExit guard short-circuits.
      const dying = session.pty;
      session.pty = null;
      try { dying.kill(); } catch {}
    }
    this.sessions.delete(id);
    this._persist();
    this.emit('closed', { id });
  }

  // Kill every pty (used on shutdown). Does not broadcast.
  killAll() {
    for (const session of this.sessions.values()) {
      clearTimeout(session._idleTimer);
      if (session.pty) { try { session.pty.kill(); } catch {} }
    }
  }
}

// Export a singleton instance.
module.exports = new SessionManager();
