# Claude Web UI

Local web app that runs the Claude Code CLI inside a real PTY, streamed into a
browser tab over WebSocket. Multi-session, survives page reloads and server
restarts. Windows-first (spawns via `@lydell/node-pty`'s Windows backend), but
most of the backend is platform-agnostic.

`README.md` is the user-facing doc (features, install, how to run). This file
is for whoever (human or Claude) is editing the code.

## Architecture

- `server/` — backend, plain Node CommonJS (no build step).
  - `index.js` — express + `ws` wiring. Serves `web/dist` in production, mounts
    `GET /api/dirs` and `GET /api/plan-usage`, and owns the single `/ws`
    WebSocket endpoint. Every ws connection is a *subscriber* to `sessionManager`
    — see the message protocol table in `REWRITE_SPEC.md` for the full
    client↔server message list.
  - `sessionManager.js` — the core of the app. Holds `Map<id, session>` where
    each session owns a live `node-pty` process, independent of any WebSocket.
    That's what makes sessions survive a page reload (the pty just keeps
    running; a new ws just re-subscribes and replays the scrollback buffer).
    Session metadata (id/cwd/title, not the pty) is persisted to
    `sessions.json` on every change and rehydrated as "stopped" ghosts on
    server restart — the user resumes them with `--continue`.
  - `claude.js` — locates the Claude CLI launcher (`findClaude()`) and spawns
    it (`spawnClaude()`). **Windows gotcha:** `where claude` can return an
    extensionless POSIX shell shim (`#!/bin/sh`, dropped by npm global installs
    for cross-platform use) before `claude.cmd`/`claude.exe`. Windows
    `CreateProcess` cannot execute that shim (fails with error 193, which
    crashes the whole server via an unhandled async exception in node-pty).
    `findClaude()` therefore filters `where` output to `.cmd`/`.exe`/`.bat`
    only on `win32`. If Claude ever fails to launch with error 193 again,
    check this first — `node -e "console.log(require('./server/claude.js').CLAUDE)"`.
  - `git.js` — shells out to `git` for the per-session "Sync from GitHub"
    feature (clone into an empty folder, or `pull --ff-only`), streaming
    output. Also `gitDiff()` for the diff panel.
  - `fs.js` — folder browser (`listDir`), used by the folder picker UI.
  - `config.js` — load/save `config.json` (repo URL/branch/autoSync,
    recent/pinned folders). Normalizes shape on load.
- `web/` — frontend, Vite + Svelte 5 (runes mode) + TypeScript.
  - `src/lib/connection.ts` — the reconnecting WebSocket client singleton.
    Every new server→client message type needs a case here.
  - `src/stores/` — Svelte stores (`sessions`, `config`, `theme`, `ui`)
    fed by `connection.ts`.
  - `src/components/` — `Terminal.svelte` (xterm.js), `Sidebar.svelte`,
    `Tabs.svelte`, `TopBar.svelte`, `Settings.svelte`, `CommandPalette.svelte`
    (⌘K), `FolderPicker.svelte`, `DiffPanel.svelte`, `Toasts.svelte`.
  - `npm run build` emits `web/dist`, which `server/index.js` serves statically
    in production. In dev, Vite serves the UI directly and proxies `/api`+`/ws`.

`server.js` + `public/index.html` at the repo root are the **old pre-rewrite
single-file version**, kept only for behavioral reference (`REWRITE_SPEC.md`
documents the port). Don't modify them; new code lives in `server/` and `web/`.

## Local runtime state (gitignored, machine-specific — never commit)

`config.json`, `sessions.json`, `server.pid`, `.claude-web-images/`,
`.claude-web-files/`, `node_modules/`, `web/dist/`. These hold this machine's
folder paths, open sessions, and installed deps — none of it is portable
across machines and none of it belongs in the repo.

## Commands

```bash
npm install          # deps
npm run dev           # server (:4280) + Vite dev server (:5173) with HMR
npm run build         # emit web/dist for production
npm start             # serve the built app from the Node server on :4280
npm run check         # svelte-check (TypeScript/Svelte type checking)
npm test              # vitest — server-side unit tests (see server/*.test.js)
```

## Testing

Vitest (`vitest.config.ts` at the repo root — deliberately separate from
`vite.config.mts`, which sets `root: 'web'` for the frontend build; a
`vitest.config.*` file replaces rather than merges with `vite.config.mts`, so
this one is self-contained and scoped to `server/**/*.test.js`) with
`globals: true`, because Vitest 4's CJS entry point throws if a test file
does `require('vitest')` directly. Two mocking gotchas that bit the first
round of tests, worth knowing before adding more:
- `vi.mock()` rewrites ESM import graphs — it does **not** intercept plain
  CommonJS `require()` calls. Server files that destructure a collaborator at
  module load time (`const { execSync } = require('child_process')`, `const
  { spawnClaude } = require('./claude')`) need that dependency replaced
  *before* the first `require()` of the file under test: either monkey-patch
  the real module's method directly (`cp.execSync = vi.fn()`, see
  `claude.test.js`) or stub the module in `require.cache` (see
  `sessionManager.test.js`, `update.test.js`).
- Don't mock `fs.readFileSync` globally before requiring an app module for
  the first time — Node's own module loader uses `fs.readFileSync` to read
  the `.js` source off disk, so a throw-on-everything mock installed too
  early breaks the `require()` itself. Require first, mock after.

There's no end-to-end browser test harness. Before committing a change:
1. `npm run check` (types) and `npm test` (unit tests) must pass.
2. `npm run build` must succeed.
3. Manually exercise the actual behavior you changed — the ws protocol is
   easy to drive headlessly with the `ws` package (see `ws-life.js` for an
   example of scripting create → stream → restart → close over the socket)
   rather than trusting types/build alone to prove a runtime behavior works.

## Self-update

The Settings panel has an "Update app" action (confirm dialog -> streamed
progress panel). Client sends `{type:'update'}`; server replies
`{type:'updatestart'}`, zero-or-more `{type:'updatelog', data}`, then one
`{type:'updatedone', ok, message, restarting}`. `server/update.js`
(`runUpdate()`) does `git pull --ff-only` + `npm install` + `npm run build` in
the app's own directory (`path.join(__dirname, '..')`, never a session's
cwd), stopping at the first failure so a broken pull/install/build never
triggers a restart. On full success, `server/index.js`'s `case 'update':`
spawns a new detached process running the same entrypoint, then calls the
existing `shutdown()`. Because the new process may race the old one for port
4280, `index.js` retries `server.listen()` on `EADDRINUSE` a few times before
giving up — expected, not exceptional, given how the restart works.

Restarting drops every live PTY (sessions come back as resumable "stopped"
ghosts, same as any server restart — no Claude conversation history is lost,
that's stored by the CLI itself under `~/.claude/projects`). Because this app
may be hosting the very Claude Code session used to edit it, treat testing the
restart path with the same care as `git push --force`: don't trigger it from
inside a session you care about staying connected.
