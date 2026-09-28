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
  - `backup.js` — backup/restore for moving to another machine. Two things
    travel together and only one is ours: app state (`config.json`,
    `sessions.json`) and the CLI's transcripts under
    `~/.claude/projects/<slug>/`. Every path in both is absolute, and the slug
    is *derived from* the folder's path, so a restore at a different path needs
    remapping or the transcript is present but unreachable. `restoreBackup()`
    rewrites the slug, the session/config paths, and the `cwd` field inside
    each transcript record — and deliberately does **not** rewrite
    `trackingPath` or paths embedded in conversation content, which are a
    historical record of the old machine rather than something used to locate
    anything. Restoring rewrites files the running `sessionManager` owns, so
    it needs a restart to take effect; backing up is read-only and safe live.
    In practice it doesn't need one: a restore is only meaningful when nothing
    is running, so `index.js` calls `sessionManager.reloadFromDisk()`
    afterwards, which refuses while any pty is live and otherwise re-reads
    `sessions.json` and broadcasts the new list to every tab. Without that
    reload the next `_persist()` would overwrite the restore with the stale
    in-memory list.

    The project **folders** are not in the backup — they're git checkouts, and
    cloning is cheaper than copying `node_modules` to a USB stick. So a v2
    manifest records each project's `repo` (`{url, branch}`, or `null` for a
    folder that isn't a checkout) plus the `commonRoot` every project path
    shares. That's what makes the simple restore possible: the user names one
    `workDir`, the remap is derived as `commonRoot -> workDir`, and
    `restoreBackup()` *provisions* each folder first — `git clone` via the same
    `syncRepo()` the Sync button uses, or `mkdir` for a non-repo — before
    remapping anything. Cloning happens shallowest-path first, because
    `syncRepo()` refuses to clone into a non-empty folder and a nested project
    would otherwise block its own parent. Provisioning runs only for the
    `workDir` flow; an explicit `remap` means the user is pointing at folders
    they already have, so cloning over them isn't ours to do.

    The consequence is that **only pushed work survives a restore**, so
    `planBackup()` reports `atRisk`: per-repo `dirty`/`unpushed` counts (no
    upstream at all counts as unpushed — a clone can't bring that branch back).
    The UI warns and lets the user proceed, same posture as the busy-session
    warning before an update restart; nothing here blocks a backup. Note the
    session-dropping rule interacts with this: in a real run the filesystem is
    the only check, so a clone that *failed* correctly leaves its session
    dropped rather than pointing at a folder that was never created. Only
    `dryRun` predicts, since it creates nothing — otherwise every preview would
    report every session as skipped. `gitInfo` and `cloneOrPull` are injectable
    so the tests need neither a real repo nor a network; `e2e` coverage against
    real `git` with a local bare remote is the thing that actually proves the
    clone path, since a mock can't.

    A `workDir` restore takes minutes, so `index.js` streams progress as
    `{type:'restorelog', data}` between `restorestart` and `restoredone`,
    mirroring `update`. v1 backups are still readable (`SUPPORTED_VERSIONS`)
    but have no recorded root or remotes, so they need the manual old→new
    root pair — which the restore modal keeps behind a toggle.

    A destination ending in `.zip` writes one file instead of a tree, and
    `restoreBackup()` takes either (a zip is extracted to a temp dir, used, then
    removed — so everything past `openBackup()` only ever sees a directory).
    Both outputs are rendered from one entry list, so they can't drift apart.
    `yazl`/`yauzl` rather than a hand-rolled writer: zip needs deflate, a CRC32
    per entry and a central directory, which is a different proposition from the
    ~40-line `ar` writer in `build-deb.js`. They stream, which matters — a 1 GB
    backup must never have to fit in memory, and `addFile()` reads lazily so no
    staging copy is needed. Compression is dramatic because transcripts are
    repetitive JSON text. Note `createBackup()` is therefore **async**.

    Archive entry names are treated as untrusted (`safeEntryPath` rejects `..`
    and absolute escapes): a backup arrives from another machine on removable
    media and is trivially editable, so "we wrote it" isn't a safety argument.

    `resolveDest()` decides what a destination means: `*.zip` is that exact file,
    an **existing folder** gets a dated `.zip` inside it, and a path that isn't
    there yet is written as a folder tree. The middle case exists because the
    original rule — empty or absent — rejected the most natural action a person
    has: a folder picker can only return folders that exist, and those normally
    have things in them, so "already exists and is not empty" fired on a correct
    user action and left them stuck. Since the filename is then ours rather than
    theirs, `createBackup()` returns `dest` and names it in the message; don't
    reduce that to "backup complete".
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

## Packaging (.exe / .deb)

`scripts/package.js` stages a self-contained, runnable tree for one platform
(`--target win32-x64|linux-x64|…`); both installers just wrap its output, so
the layout can be built and run locally without either toolchain. What ships is
`server/` (minus tests), `web/dist` and whatever is in package.json
`dependencies` — copied verbatim, so a new runtime dep needs no change in
`package.js`. Vite/Svelte/Rollup are devDependencies that produce `web/dist`
and never travel.

Cross-building works because the one native dep, `@lydell/node-pty`, publishes
per-platform prebuilds as optional deps: `npm install --os=linux --cpu=x64`
fetches the Linux binding from Windows, so a Linux tree needs no compiler, no
Docker and no WSL. The script fails loudly if the prebuild that landed doesn't
match the target — otherwise the mistake only surfaces as a failed spawn on the
user's machine.

`scripts/build-deb.js` turns a staged Linux tree into a .deb. A .deb is an
`ar` archive of `debian-binary` + `control.tar.gz` + `data.tar.gz`, in that
order; the tarballs come from GNU tar (`--force-local`, because GNU tar
otherwise reads `C:…` as `host:path`) and the ~40-line `ar` writer is here,
so no dpkg-deb is needed. Installs to `/opt/claude-web-ui` with a
`/usr/bin/claude-web-ui` wrapper and a systemd **user** service — user, not
system, because the app runs as you and reads your `~/.claude`.

`packaging/windows/claude-web-ui.iss` is the Inno Setup script. Per-user
install (`PrivilegesRequired=lowest`) so there's no UAC prompt.

`.github/workflows/release.yml` builds both on a v-tag and attaches them to a
GitHub Release — which doubles as the update feed (see below).

## Self-update

The Settings panel has an "Update app" action (confirm dialog -> streamed
progress panel). Client sends `{type:'update', force}`; server replies
`{type:'updatestart'}`, zero-or-more `{type:'updatelog', data}`, then one
`{type:'updatedone', ok, message, restarting}`.

Because the restart kills every live pty, the confirm dialog names the sessions
it would disrupt, split by cost: `sessionManager.activeSessions()` returns
`{busy, idle}`, where **busy** means output is still streaming (that session
can lose the reply mid-turn) and **idle** means a live pty that only loses its
scrollback. `force: true` means "the user saw the busy warning and chose to go
ahead"; the server re-checks `activeSessions()` on arrival and refuses without
it, which catches a session that started working while the dialog sat open.
Note `busy` is inferred from output plus an idle timer, so it *under*-reports —
a session parked on a permission prompt emits nothing and reads as idle. That's
why this warns rather than blocks.

`server/update.js` (`runUpdate()`) does `git pull --ff-only` + `npm install` +
`npm run build` in the app's own directory (`path.join(__dirname, '..')`, never
a session's cwd), stopping at the first failure so a broken pull/install/build never
triggers a restart. On full success, `server/index.js`'s `case 'update':`
spawns a new detached process running the same entrypoint, then calls the
existing `shutdown()`. Because the new process may race the old one for port
4280, `index.js` retries `server.listen()` on `EADDRINUSE` a few times before
giving up — expected, not exceptional, given how the restart works.

**That retry silently didn't work for a long time.** Attaching a
`WebSocketServer` to an existing http server makes `ws` re-emit that server's
`'error'` on the `WebSocketServer` too. With no listener there the duplicate is
an unhandled `'error'` event, so the process died instantly and the retry never
ran — every restart was a coin flip on whether the outgoing server had already
released the port, and when it hadn't the app came back *down*. Hence
`wss.on('error')` in `index.js`, which exists purely to make the copy non-fatal
and leave the decision to `server.on('error')`. Don't remove it. The budget is
20 × 250ms = **5 seconds total**, so anything automating a restart has to stop
the old process promptly after spawning the replacement, or the replacement
gives up and you are left with nothing listening.

**Windows gotcha for any child process:** Node defaults `windowsHide` to
`false`, so every `spawn`/`execFile` pops a console window. One is a flicker;
`planBackup()` fanning ~3 git calls across a dozen projects is a screenful, and
creating the windows costs far more than the commands. Every git spawn here sets
`windowsHide: true` (`backup.js`, `git.js`'s `runGit` and `collectGit`,
`update.js`'s shelled npm) — match that in anything new. Note this can't be
caught by measuring from a test harness: node attached to a console creates no
windows either way, so it only shows up when the server runs windowless.

Restarting drops every live PTY (sessions come back as resumable "stopped"
ghosts, same as any server restart — no Claude conversation history is lost,
that's stored by the CLI itself under `~/.claude/projects`). Because this app
may be hosting the very Claude Code session used to edit it, treat testing the
restart path with the same care as `git push --force`: don't trigger it from
inside a session you care about staying connected.
