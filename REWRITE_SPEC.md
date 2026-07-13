# Claude Web UI v2 — Build Spec (contract for all sub-agents)

A local web app that runs **Claude Code** in the browser. Overhaul of a single-file app into:
**Vite + Svelte 5 (TypeScript) frontend** + **modular Node/Express/ws backend** with
**persistent, multi-session** PTYs that survive page reload. Local-only (`127.0.0.1`).

The OLD implementation (reference for behavior to preserve) is `server.js` and
`public/index.html` in the repo root. Do NOT modify those — the new code lives in
`server/` and `web/`.

---

## Repo layout (target)

```
server/                 # backend (Node, CommonJS)
  index.js              # http + express + ws wiring, static serve of web/dist
  sessionManager.js     # persistent multi-session PTY manager
  claude.js             # locate launcher + spawn opts + WEB_SYSTEM_PROMPT
  git.js                # syncRepo(...) streaming
  fs.js                 # listDir(...) folder browser
  config.js             # load/save config.json
web/                    # frontend (Vite + Svelte 5 + TS)
  index.html
  src/
    main.ts             # mounts App, calls conn.connect()
    app.css             # theme tokens + global styles
    lib/connection.ts   # reconnecting WS client (singleton `conn`)
    stores/sessions.ts  config.ts  theme.ts  ui.ts
    components/
      Terminal.svelte  Sidebar.svelte  Tabs.svelte  TopBar.svelte
      CommandPalette.svelte  FolderPicker.svelte  Settings.svelte
      Toasts.svelte  StatusDot.svelte
    App.svelte
```

Foundation files (configs, connection.ts, all stores, app.css, Terminal.svelte,
App.svelte, StatusDot.svelte) are written by the integrator. Sub-agents build the
files assigned to them ONLY, importing the foundation as-is.

---

## WebSocket protocol (JSON messages, mounted at path `/ws`)

A **session** = `{ id: string, cwd: string, title: string, status: 'starting'|'running'|'stopped' }`.
`title` = the last path segment of `cwd`.

### Client → Server
- `{type:'list'}` — request current sessions. Server replies `sessions`.
- `{type:'create', cwd, cols, rows}` — create + spawn a session in `cwd`.
- `{type:'attach', id, cols, rows}` — subscribe to a session; server replays its
  scrollback buffer (as `data` msgs) then streams live. Resizes pty to cols/rows.
- `{type:'close', id}` — kill the pty + drop the session.
- `{type:'input', id, data}` — write keystrokes to the session's pty.
- `{type:'resize', id, cols, rows}`
- `{type:'setcwd', id, cwd, cols, rows}` — respawn the session's Claude in a new folder.
- `{type:'restart', id, cols, rows}` — respawn Claude in the same folder.
- `{type:'sync', id}` — git clone/pull into the session's cwd; stream output.
- `{type:'getconfig'}` / `{type:'saveconfig', repoUrl, branch, autoSync, recents, pinned}`
- `{type:'image', id, data, ext}` — save pasted image under cwd/.claude-web-images, type path into pty.
- `{type:'file', id, name, data}` — save attached file under cwd/.claude-web-files, type path into pty.

### Server → Client
- `{type:'sessions', sessions:[...]}` — full list (reply to list/connect).
- `{type:'created', session}` — a new session was created.
- `{type:'session', session}` — a session changed (status/cwd/title).
- `{type:'closed', id}` — a session ended/was removed.
- `{type:'data', id, data}` — pty output for a session.
- `{type:'cwd', id, path}` — convenience; cwd of a session.
- `{type:'config', repoUrl, branch, autoSync, recents, pinned}` — current config.
- `{type:'syncstart', id}` / `{type:'synclog', id, data}` / `{type:'syncdone', id, ok, message}`

### REST (Express)
- `GET /api/dirs?path=<abs|__drives__>` → `{ path, parent, dirs:[{name,path}] }`
  (folder browser; `__drives__` lists drive letters on Windows). Port from old `server.js`.

---

## Backend requirements (server/)

Port ALL behavior from the old `server.js`, generalized to multi-session:

- **claude.js**: export `findClaude()` result as `CLAUDE`, and `WEB_SYSTEM_PROMPT`
  (copy verbatim from old server.js lines 25–36), and a `spawnClaude(cwd, cols, rows)`
  helper that returns a pty using `@lydell/node-pty` with the same args/env
  (`--dangerously-skip-permissions --append-system-prompt <prompt>`, FORCE_COLOR=3,
  NODE_PATH prepending this app's node_modules).
- **sessionManager.js**: a class/object holding `Map<id, {pty, cwd, status, title, buffer}>`.
  - `buffer` = a bounded scrollback string (cap ~256 KB; trim from front).
  - One EventEmitter (or callback registry) broadcasts `data/session/closed` to subscribers.
  - **Persistence across reload is the whole point**: PTYs live here, NOT tied to a ws.
  - When respawning (setcwd/restart/create-existing), guard the old pty's async
    `onExit` so it can't null/clobber the new one (the bug fixed in old code) — easy
    here since each session owns its own pty reference; just check identity.
  - Generate ids without `Date.now()`/`Math.random()` is NOT required on the backend
    (that restriction is only for workflow scripts). Use a simple incrementing counter
    or `crypto.randomUUID()`.
- **git.js**: `syncRepo(cwd, onData)` — copy clone/pull logic from old server.js
  (lines ~88–147), streaming via onData. Honors config.repoUrl/branch.
- **fs.js**: `listDir(target)` — copy `/api/dirs` logic from old server.js (lines ~161–192).
- **config.js**: `loadConfig()/saveConfig()` against `config.json` in repo root; include
  new fields `recents: string[]` and `pinned: string[]` (default `[]`).
- **index.js**: express app; in production serve `web/dist` statically (only if it
  exists); mount `GET /api/dirs`; create `WebSocketServer({ server, path: '/ws' })`;
  on each connection register as a subscriber and handle all client→server messages
  above, delegating to sessionManager. On `image`/`file`, save under the SESSION's cwd
  (look it up by id) exactly like old code, then `pty.write('"<path>" ')`.
  Listen on `127.0.0.1:4280` (PORT env overridable). Keep a startup console banner.
  Graceful shutdown (SIGINT) kills all ptys.

CommonJS (`require`/`module.exports`). No TypeScript in `server/`.

---

## Frontend conventions (Svelte 5 — STRICT)

This project uses **Svelte 5 runes mode**. All components MUST follow this exactly
(match the canonical example `StatusDot.svelte` the integrator provides):

- `<script lang="ts">`.
- Props: `let { foo, bar } = $props();` — **never** `export let`.
- Local reactive state: `let n = $state(0);`
- Derived: `const d = $derived(expr);`
- Effects: `$effect(() => { ... });`
- **Event handlers are attributes**: `onclick={...}`, `oninput={...}`, `onkeydown={...}`
  — **never** `on:click`.
- Read a store with `$storeName` in markup/script (auto-subscription works in runes mode).
- Import stores from `../stores/...` and the ws client from `../lib/connection`.
- Keep styles in a component `<style>` block; use the CSS variables from `app.css`
  (`--bg, --panel, --border, --accent, --accent-dim, --text, --muted`). These vars are
  redefined under `:root[data-theme="light"]` for light mode — so just use the vars.

### Store APIs available to components (already implemented by integrator)
```ts
// stores/sessions.ts
export const sessions: Readable<Session[]>;
export const activeId: Writable<string>;       // currently focused session id
export function createSession(cwd: string, cols?: number, rows?: number): void;
export function closeSession(id: string): void;
export function setActive(id: string): void;
export function setSessionCwd(id: string, cwd: string): void; // change folder
export function restartSession(id: string): void;
export function syncSession(id: string): void;
export type Session = { id:string; cwd:string; title:string; status:string };

// stores/config.ts
export const config: Writable<{repoUrl:string;branch:string;autoSync:boolean;recents:string[];pinned:string[]}>;
export function saveConfig(patch: Partial<...>): void;
export function addRecent(path: string): void;
export function togglePinned(path: string): void;

// stores/theme.ts
export const theme: Writable<'dark'|'light'|'system'>;
export const fontSize: Writable<number>;

// stores/ui.ts
export const showFolderPicker: Writable<boolean>;
export const folderPickerTarget: Writable<'new'|'current'>; // create new vs change active
export const showSettings: Writable<boolean>;
export const showPalette: Writable<boolean>;
export function toast(text: string): void;
export const toasts: Readable<{id:number,text:string}[]>;

// lib/connection.ts
export const conn: { send(m:any):void; on(h:(m:any)=>void):()=>void; onStatus(f:(s:string)=>void):()=>void; connect():void };
```

Use these; do not invent new store exports. If a component needs a one-off REST call,
use `fetch('/api/dirs?...')`.
