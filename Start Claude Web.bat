@echo off
title Claude Code Web UI
cd /d "%~dp0"

echo Starting Claude Code Web UI...
echo.

REM --- Check Node.js (required) ---
where node >nul 2>nul
if errorlevel 1 (
    echo Node.js is required but was not found.
    echo Please install Node.js LTS from https://nodejs.org and try again.
    echo.
    pause
    exit /b 1
)

REM --- First run on this PC: install dependencies if missing ---
if not exist "node_modules" (
    echo First run on this PC - installing dependencies ^(one time^)...
    echo.
    call npm install
    echo.
)

REM --- Build the web UI if it hasn't been built yet ---
if not exist "web\dist\index.html" (
    echo Building the web interface ^(one time^)...
    echo.
    call npm run build
    echo.
)

REM --- Check Git (needed for GitHub sync, not required to run) ---
where git >nul 2>nul
if errorlevel 1 (
    echo Note: Git was not found. GitHub sync needs Git from https://git-scm.com
    echo The app still works without it.
    echo.
)

REM --- Check Claude CLI (needed to actually run Claude) ---
where claude.cmd >nul 2>nul
if not errorlevel 1 goto claude_ok
where claude >nul 2>nul
if not errorlevel 1 goto claude_ok
echo Note: the Claude CLI was not found.
echo Install it with:  npm install -g @anthropic-ai/claude-code
echo.
:claude_ok

REM Open the browser shortly after the server boots.
start "open browser" /min cmd /c "ping -n 3 127.0.0.1 >nul & start http://127.0.0.1:4280"

REM Run the server in this window (close it to stop the server).
node server/index.js

echo.
echo Server stopped. Press any key to close.
pause >nul
