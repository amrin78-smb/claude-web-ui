# Claude Code Web UI

A local web page that runs **Claude Code** with `--dangerously-skip-permissions`
in your browser, so you don't have to open PowerShell and type the command every
time.

## Install (first time on a PC)

Double-click **`Install.bat`**. It uses Windows' built-in **winget** to install
**Node.js** and **Git** *only if they're missing*, then installs the **Claude Code
CLI**, installs this app's dependencies, and creates **Desktop + Start Menu
shortcuts** ("Claude Code"). You may see a Windows UAC prompt for the Node/Git
installs — that's normal. It's safe to re-run; anything already present is skipped.

> Needs an internet connection the first time (to download Node/Git/Claude).
> After that everything runs locally.

## Run it

Double-click the **Claude Code** Desktop shortcut (or **`Start Claude Web.bat`**).

It starts a small local server, opens `http://127.0.0.1:4280` in your browser a
couple of seconds later, and runs Claude Code already pointed at your working
folder. **Closing the black console window stops the server.**

If you instead launch it via **`Start Claude Web (Background).vbs`** (no
console window at all — useful for keeping it running unattended), there's
nothing to close. Use the **Stop Claude Code** Desktop shortcut (or
**`Stop Claude Web.bat`**) to shut it down — it finds the running server (via
a `server.pid` file the server writes on startup) and closes it the same way
Ctrl+C would, so open Claude sessions get cleaned up properly instead of just
being killed.

## Features

- **Real terminal** — the full Claude Code TUI, right in the browser.
- **Persistent sessions** — the running Claude lives on the server, not in the
  browser tab. Reload the page, close the laptop lid, reconnect later — your
  session (and its scrollback) is still there. No more "had to restart after a
  reload."
- **Session memory across restarts** — even if you fully close the app (the black
  console window) or reboot, the list of folders/sessions you had open comes back
  the next time you launch. Each restored session shows a **"Pick up where you
  left off"** card: **↩ Resume last conversation** relaunches Claude with
  `--continue`, reopening that folder's most recent conversation *with its full
  prior context*, or **Start fresh** begins a clean one. (Resume is offered only
  when Claude actually has saved history for that folder.) Also available in the
  ⌘K palette as **Resume last conversation**. The open-session list is stored in
  `sessions.json` in the app folder.
- **Multiple projects at once** — a **sidebar** of projects/sessions and a **tab
  bar** let you run several Claude sessions in different folders side by side and
  switch instantly.
- **⌘K / Ctrl+K command palette** — fuzzy-search every action (new session,
  change folder, restart, sync, settings, theme, jump to a session).
- **Light / dark / system theme** and adjustable terminal **font size**, in
  Settings.
- **📁 Change folder** — browse your drives/folders or paste a full path, opening
  it in a new session or the current one. Pin and reuse **recent folders** from
  the sidebar. The first time Claude opens a new folder it asks a "do you trust
  this folder?" question — just answer it like normal.
- **🖼 Paste image** — press **Ctrl+V** anywhere on the page with an image in
  your clipboard (e.g. a screenshot), or click the button to pick a file. The
  image is saved into `.claude-web-images/` inside the current folder and its
  path is typed into the prompt for you. Add your question and press Enter.
- **📎 Attach file** — attach a **PDF, Excel, Word, CSV, or any file** (button or
  **drag & drop** anywhere on the page). It's saved into `.claude-web-files/` in the
  current folder and its path is typed into the prompt. Claude reads PDFs directly
  and writes a quick script to parse Excel/Word/CSV. Add your question and press Enter.
- **Make PowerPoint** — just ask (e.g. *"turn this Excel into a 6-slide deck"*). The
  Node library **`pptxgenjs`** is pre-installed and made available to any script Claude
  runs (via `NODE_PATH`), so the `.pptx` is generated straight into your working folder —
  no setup, no Python needed.
- **↻ Restart** — restarts Claude in the same folder (per session).
- **⚙ Settings** — GitHub repo URL/branch + auto-sync, theme, and font size.
- **⟳ Sync from GitHub** — clones the repo if the working folder has no repo
  yet, otherwise does a `pull --ff-only`. The output streams live in a panel.
- **Auto-sync on open** — when enabled in Settings, the configured repo is
  cloned/pulled into the working folder every time the page opens, *before*
  Claude starts.

## GitHub authentication

- **Public repos** work with no setup.
- **Private repos** use your existing **Git Credential Manager** or **SSH** keys
  — nothing extra to configure here.
- Git runs with `GIT_TERMINAL_PROMPT=0`, so if credentials are missing it
  **fails clearly instead of hanging** waiting for input.

## Use on another PC (portability)

Copy the whole `claude-web-ui` folder (to another Windows PC or a USB stick).

On the target PC you'll want:

- **Node.js (LTS)** — https://nodejs.org
- **The Claude CLI** — `npm install -g @anthropic-ai/claude-code`
- **Git** — https://git-scm.com (only needed for sync)

On first launch the `.bat` automatically runs `npm install` if `node_modules`
is missing, so it self-heals on a fresh machine.

> The Desktop shortcut is machine-specific and won't copy across. Recreate it on
> the new PC: right-click `Start Claude Web.bat` → *Send to* →
> *Desktop (create shortcut)*.

## Notes

- Everything stays on your machine (**localhost only**). Nothing leaves the
  machine except the traffic to Claude itself.
- `--dangerously-skip-permissions` is **always on by design** — that was the
  whole point. Only use it on folders/projects you trust.
- Default port is **4280**. To change it, set the `PORT` environment variable
  before launching.
- A **`config.json`** is created in the app folder to remember your repo URL,
  branch, auto-sync setting, and recent/pinned folders.

## How it works (for the curious)

- **Backend** (`server/`, plain Node/CommonJS): a `sessionManager` keeps each
  Claude CLI process alive inside a ConPTY, independent of any browser socket,
  with a scrollback buffer it replays on reconnect — that's what makes sessions
  survive reloads. `git.js` shells out for sync, `fs.js` powers the folder
  browser, `config.js` persists settings. Everything is streamed to the browser
  over a single WebSocket (`/ws`).
- **Frontend** (`web/`, Vite + Svelte 5 + TypeScript): a reconnecting WebSocket
  client, Svelte stores for sessions/config/theme, and [xterm.js](https://xtermjs.org/)
  for each terminal. `npm run build` emits `web/dist`, which the Node server
  serves in production.

## Develop

```bash
npm install          # deps
npm run dev          # Node server (:4280) + Vite dev server (:5173) with HMR
# open http://127.0.0.1:5173  (Vite proxies /api and /ws to the Node server)

npm run build        # emit web/dist for production
npm start            # serve the built app from the Node server on :4280
```

> The previous single-file version (`server.js` + `public/index.html`) is kept in
> the repo for reference. Once you've confirmed the new UI works in your browser,
> those two files can be deleted.
