@echo off
title Install Claude Code Web UI
cd /d "%~dp0"

echo.
echo  Installing Claude Code Web UI...
echo  (This may show Windows "User Account Control" prompts for Node/Git.)
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"

echo.
pause
