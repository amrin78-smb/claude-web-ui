@echo off
title Stop Claude Web UI
cd /d "%~dp0"

echo Stopping Claude Code Web UI...
echo.

set "PID="
if exist "server.pid" set /p PID=<"server.pid"

if not "%PID%"=="" (
    tasklist /FI "PID eq %PID%" 2>nul | find "%PID%" >nul
    if not errorlevel 1 (
        echo Stopping server ^(PID %PID%^)...
        REM Soft close first, so it can shut down its Claude sessions cleanly.
        taskkill /PID %PID% >nul 2>nul
        ping -n 3 127.0.0.1 >nul
        tasklist /FI "PID eq %PID%" 2>nul | find "%PID%" >nul
        if not errorlevel 1 (
            echo Still running - forcing it closed...
            taskkill /PID %PID% /F >nul 2>nul
        )
    ) else (
        echo Saved PID %PID% is not running ^(already stopped?^).
    )
) else (
    echo No server.pid found - checking port 4280 directly...
)

REM Belt-and-suspenders: catch anything still bound to the port — covers a
REM stale/missing pidfile, e.g. a server started before this script existed.
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /C:":4280 " ^| findstr "LISTENING"') do (
    echo Stopping process on port 4280 ^(PID %%p^)...
    taskkill /PID %%p /F >nul 2>nul
)

if exist "server.pid" del "server.pid" >nul 2>nul

echo.
echo Done. Any open browser tabs will show "disconnected" until you start it again.
echo.
pause
