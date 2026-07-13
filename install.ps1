# Claude Code Web UI - one-click installer (Windows)
# Installs Node.js + Git (via winget, only if missing), then the Claude CLI,
# then this app's dependencies, and creates Desktop + Start Menu shortcuts.
# Re-runnable: anything already present is skipped.

$ErrorActionPreference = 'Stop'
$AppDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$Bat     = Join-Path $AppDir 'Start Claude Web.bat'
$StopBat = Join-Path $AppDir 'Stop Claude Web.bat'

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }
function Step($n, $msg) { Write-Host ""; Write-Host "[$n] $msg" -ForegroundColor Cyan }

# Pull the latest Machine+User PATH (plus the usual Node locations) into THIS
# session, so tools installed a moment ago are immediately usable.
function Update-SessionPath {
  $m = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $u = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = (($m, $u) -join ';')
  foreach ($e in @("$env:ProgramFiles\nodejs", "$env:APPDATA\npm", "$env:ProgramFiles\Git\cmd")) {
    if ((Test-Path $e) -and ($env:Path -notlike "*$e*")) { $env:Path += ";$e" }
  }
}

function Have($name) { return [bool](Get-Command $name -ErrorAction SilentlyContinue) }

Write-Host ""
Write-Host "  ===================================================" -ForegroundColor DarkCyan
Write-Host "   Claude Code Web UI - Installer" -ForegroundColor White
Write-Host "  ===================================================" -ForegroundColor DarkCyan
Say   "   App folder: $AppDir"

Update-SessionPath

# --- winget present? ------------------------------------------------------
if (-not (Have 'winget')) {
  Say ""
  Say "  winget (App Installer) was not found." 'Yellow'
  Say "  Open the Microsoft Store, update 'App Installer', then run this again." 'Yellow'
  Say "  (Or install Node.js and Git manually, then re-run.)" 'Yellow'
  Read-Host "`nPress Enter to exit"
  exit 1
}

$wingetCommon = @('-e', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements', '--silent')

# --- Node.js --------------------------------------------------------------
Step 1 "Node.js"
if (Have 'node') {
  Say "  Already installed: $(node --version)" 'Green'
} else {
  Say "  Installing Node.js LTS via winget (a UAC prompt may appear)..."
  winget install --id OpenJS.NodeJS.LTS @wingetCommon
  Update-SessionPath
  if (Have 'node') { Say "  Installed: $(node --version)" 'Green' }
  else { Say "  Node still not detected on PATH. You may need to close and reopen, then re-run." 'Yellow' }
}

# --- Git ------------------------------------------------------------------
Step 2 "Git"
if (Have 'git') {
  Say "  Already installed: $(git --version)" 'Green'
} else {
  Say "  Installing Git via winget (a UAC prompt may appear)..."
  winget install --id Git.Git @wingetCommon
  Update-SessionPath
  if (Have 'git') { Say "  Installed: $(git --version)" 'Green' }
  else { Say "  Git not detected yet (used only for repo sync). You can install it later." 'Yellow' }
}

# --- Claude CLI -----------------------------------------------------------
Step 3 "Claude Code CLI"
if (Have 'claude') {
  Say "  Already installed." 'Green'
} elseif (Have 'npm') {
  Say "  Installing @anthropic-ai/claude-code globally via npm..."
  & npm install -g '@anthropic-ai/claude-code'
  Update-SessionPath
  if (Have 'claude') { Say "  Installed." 'Green' }
  else { Say "  Claude not detected on PATH yet - reopen a terminal if needed." 'Yellow' }
} else {
  Say "  npm not available (Node install may need a reboot). Re-run this installer." 'Yellow'
}

# --- App dependencies + web build -----------------------------------------
Step 4 "App dependencies (node_modules) + web build"
if (Have 'npm') {
  Push-Location $AppDir
  try {
    & npm install
    Say "  Dependencies ready. Building the web interface..." 'Green'
    & npm run build
    Say "  Web interface built." 'Green'
  } finally { Pop-Location }
} else {
  Say "  Skipped - npm not available yet. Re-run after Node finishes installing." 'Yellow'
}

# --- Shortcuts ------------------------------------------------------------
Step 5 "Shortcuts"
function New-Shortcut($linkPath, $target, $description) {
  $sh = New-Object -ComObject WScript.Shell
  $lnk = $sh.CreateShortcut($linkPath)
  $lnk.TargetPath       = $target
  $lnk.WorkingDirectory = $AppDir
  $lnk.Description       = $description
  $lnk.IconLocation      = "$env:ProgramFiles\nodejs\node.exe,0"
  $lnk.Save()
}
$desktop  = [Environment]::GetFolderPath('Desktop')
$startDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
try {
  New-Shortcut (Join-Path $desktop  'Claude Code.lnk')      $Bat     'Run Claude Code in your browser'
  New-Shortcut (Join-Path $startDir 'Claude Code.lnk')      $Bat     'Run Claude Code in your browser'
  New-Shortcut (Join-Path $desktop  'Stop Claude Code.lnk') $StopBat 'Stop the Claude Code Web UI server'
  New-Shortcut (Join-Path $startDir 'Stop Claude Code.lnk') $StopBat 'Stop the Claude Code Web UI server'
  Say "  Created Desktop + Start Menu shortcuts ('Claude Code' + 'Stop Claude Code')." 'Green'
} catch {
  Say "  Could not create a shortcut: $($_.Exception.Message)" 'Yellow'
}

# --- Done -----------------------------------------------------------------
Write-Host ""
Write-Host "  ===================================================" -ForegroundColor DarkCyan
Write-Host "   Done. Launch it any time from the 'Claude Code'" -ForegroundColor White
Write-Host "   Desktop icon (or 'Start Claude Web.bat')." -ForegroundColor White
Write-Host "  ===================================================" -ForegroundColor DarkCyan

$go = Read-Host "`n  Launch Claude Code Web UI now? (Y/N)"
if ($go -match '^[Yy]') { Start-Process -FilePath $Bat -WorkingDirectory $AppDir }
