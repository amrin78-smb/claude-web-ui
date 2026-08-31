#!/usr/bin/env bash
# Linux counterpart to "Start Claude Web.bat".
#
# Starts the Claude Code Web UI server in this terminal and opens the browser
# once it's actually answering. Close the window (or Ctrl+C) to stop it — the
# server treats SIGINT/SIGTERM as a graceful shutdown, killing every PTY and
# removing server.pid, rather than leaving orphaned Claude processes behind.
set -u

# Run from the repo root no matter where the launcher was invoked from, and
# follow symlinks so a shortcut pointing here still resolves the real path.
cd "$(dirname "$(readlink -f "$0")")" || exit 1

# A .desktop launcher starts with a minimal environment that usually omits
# ~/.local/bin — which is exactly where a user-local Node and the native Claude
# CLI live on this machine. Put it back before looking for either.
export PATH="$HOME/.local/bin:$PATH"

PORT="${PORT:-4280}"
URL="http://127.0.0.1:$PORT"

# Open the UI in a dedicated Chromium "app" window: no tab strip, no URL bar,
# its own icon and its own alt-tab entry, so it behaves like a desktop app
# rather than a tab that gets lost among twenty others. Falls back to the
# default browser when no Chromium-family browser is installed.
# Set CLAUDE_WEB_BROWSER=tab to force an ordinary browser tab instead.
open_ui() {
  if [ "${CLAUDE_WEB_BROWSER:-app}" = "app" ]; then
    for b in google-chrome google-chrome-stable brave-browser chromium chromium-browser; do
      if command -v "$b" >/dev/null 2>&1; then
        "$b" --app="$URL" >/dev/null 2>&1 &
        return
      fi
    done
  fi
  xdg-open "$URL" >/dev/null 2>&1 &
}

die() { echo; echo "ERROR: $1"; echo; read -rp "Press Enter to close. "; exit 1; }

command -v node >/dev/null 2>&1 || die "Node.js is required but was not found.
Install it from https://nodejs.org, or unpack the LTS tarball into ~/.local."

# Already running? Don't fight for the port — just show the existing instance.
if curl -fsS -o /dev/null --max-time 2 "$URL" 2>/dev/null; then
  echo "Claude Code Web UI is already running at $URL — opening it."
  open_ui
  exit 0
fi

# First run on this machine: install deps and build the UI (one time each).
if [ ! -d node_modules ]; then
  echo "First run here — installing dependencies (one time)..."
  npm install || die "npm install failed."
fi
if [ ! -f web/dist/index.html ]; then
  echo "Building the web interface (one time)..."
  npm run build || die "npm run build failed."
fi

command -v git >/dev/null 2>&1 || \
  echo "Note: git not found — GitHub sync needs it. The app still works without it."
command -v claude >/dev/null 2>&1 || \
  echo "Note: the Claude CLI was not found. Install it with: npm install -g @anthropic-ai/claude-code"

# Open the window only once the server answers (up to ~15s), so it never lands
# on a connection-refused page.
(
  for _ in $(seq 1 30); do
    if curl -fsS -o /dev/null --max-time 1 "$URL" 2>/dev/null; then
      open_ui
      break
    fi
    sleep 0.5
  done
) &

echo
echo "Starting Claude Code Web UI — close this window or press Ctrl+C to stop."
echo
exec node server/index.js
