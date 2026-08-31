#!/usr/bin/env bash
# Linux counterpart to "Stop Claude Web.bat".
#
# Finds the running server via the server.pid file it writes on startup and
# stops it with SIGTERM — the same graceful path as Ctrl+C, so open Claude
# sessions get cleaned up instead of being killed outright. Falls back to
# whatever is listening on the port if the pidfile is missing or stale.
set -u

cd "$(dirname "$(readlink -f "$0")")" || exit 1
PORT="${PORT:-4280}"

stop_pid() {
  local pid="$1"
  echo "Stopping Claude Code Web UI (PID $pid)..."
  kill "$pid" 2>/dev/null || return 1
  for _ in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || { echo "Stopped."; return 0; }
    sleep 0.25
  done
  echo "Didn't stop gracefully after 5s — forcing."
  kill -9 "$pid" 2>/dev/null
  echo "Stopped."
}

if [ -f server.pid ]; then
  PID="$(cat server.pid 2>/dev/null)"
  if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
    stop_pid "$PID"
    exit 0
  fi
  echo "server.pid is stale (no such process) — checking port $PORT instead."
else
  echo "No server.pid found — checking port $PORT instead."
fi

PIDS="$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null)"
if [ -z "$PIDS" ]; then
  echo "Nothing is listening on port $PORT — the server isn't running."
  exit 0
fi
for p in $PIDS; do stop_pid "$p"; done
