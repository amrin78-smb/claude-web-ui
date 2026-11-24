import { writable, get } from 'svelte/store';
import { conn } from '../lib/connection';
import { addRecent } from './config';

export type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  costUSD: number;
  model: string | null;
};

export type Session = {
  id: string;
  cwd: string;
  title: string;
  status: string;
  // A prior Claude conversation exists for this folder that `--continue` can reopen.
  resumable?: boolean;
  // True while Claude is actively producing output for this session.
  busy?: boolean;
  // Token/cost usage for the session's current conversation (null until known).
  usage?: Usage | null;
  // Last non-empty line of output, refreshed whenever the session goes idle.
  preview?: string;
  // Reported by the bridge mod inside the session's Claude process; null (or
  // absent, from an older server) until it reports, and on a CLI without mods.
  bridged?: boolean;
  activity?: 'working' | 'waiting' | 'idle' | null;
  waiting?: { kind: 'question' | 'plan'; text: string } | null;
  context?: { tokens?: number; window: number; percent?: number } | null;
  cost?: number | null;
  // Pictures the session's tools returned (bytes at /api/sessions/:id/images/:img).
  images?: { id: string; ts: number; tool: string; mediaType: string; size: number }[];
};

// One word for what a session is doing, for dots and tooltips. Bridge state
// wins when there is any; otherwise it is the old output-timer guess.
export function activityOf(s: Session): 'stopped' | 'starting' | 'working' | 'waiting' | 'idle' {
  if (s.status === 'stopped') return 'stopped';
  if (s.status === 'starting') return 'starting';
  if (s.activity) return s.activity;
  return s.busy ? 'working' : 'idle';
}

// Hover text for a session's dot: what it is doing, and what it waits on.
export function activityLabel(s: Session): string {
  const a = activityOf(s);
  if (a === 'waiting') {
    const what = s.waiting?.kind === 'plan' ? 'Waiting for you to review the plan' : 'Waiting for your answer';
    return s.waiting?.text && s.waiting.kind !== 'plan' ? `${what}: ${s.waiting.text}` : what;
  }
  return { stopped: 'Stopped', starting: 'Starting', working: 'Working', idle: 'Idle' }[a];
}

export const sessions = writable<Session[]>([]);
export const activeId = writable<string>('');

// Keep a stable active selection as sessions come and go.
function ensureActive(list: Session[]) {
  const cur = get(activeId);
  if (!list.find((s) => s.id === cur)) {
    activeId.set(list[0]?.id ?? '');
  }
}

conn.on((m) => {
  switch (m.type) {
    case 'sessions':
      sessions.set(m.sessions || []);
      ensureActive(m.sessions || []);
      break;
    case 'created':
      sessions.update((l) => {
        const next = l.find((s) => s.id === m.session.id) ? l : [...l, m.session];
        return next;
      });
      activeId.set(m.session.id);
      if (m.session.cwd) addRecent(m.session.cwd);
      break;
    case 'session':
      // Upsert, don't just map: a 'session' event can be the first time THIS tab
      // hears about a session another tab created, in which case there's nothing
      // to map over yet.
      sessions.update((l) => {
        if (l.some((s) => s.id === m.session.id)) {
          return l.map((s) => (s.id === m.session.id ? { ...s, ...m.session } : s));
        }
        const next = [...l, m.session];
        ensureActive(next); // a tab that had nothing open should select it
        return next;
      });
      break;
    case 'closed':
      sessions.update((l) => {
        const next = l.filter((s) => s.id !== m.id);
        ensureActive(next);
        return next;
      });
      break;
  }
});

// On (re)connect, ask the server for the live session list — this is what makes
// sessions survive a page reload.
conn.onStatus((s) => {
  if (s === 'connected') conn.send({ type: 'list' });
});

export function createSession(cwd: string, cols = 120, rows = 30) {
  conn.send({ type: 'create', cwd, cols, rows });
}
export function closeSession(id: string) {
  conn.send({ type: 'close', id });
}
export function setActive(id: string) {
  activeId.set(id);
}
export function setSessionCwd(id: string, cwd: string, cols = 120, rows = 30) {
  conn.send({ type: 'setcwd', id, cwd, cols, rows });
  addRecent(cwd);
}
export function restartSession(id: string, cols = 120, rows = 30) {
  conn.send({ type: 'restart', id, cols, rows });
}
// Reopen the folder's most recent Claude conversation (server runs `--continue`).
export function resumeSession(id: string, cols = 120, rows = 30) {
  conn.send({ type: 'resume', id, cols, rows });
}
export function syncSession(id: string) {
  conn.send({ type: 'sync', id });
}
export function requestDiff(id: string) {
  conn.send({ type: 'gitdiff', id });
}
