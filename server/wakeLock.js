/* Wake lock — keep Windows from sleeping while a Claude session is busy.
 *
 * Windows only resets its sleep idle timer on local keyboard/mouse input, so
 * background work (a long Claude run, locked screen or not) needs to explicitly
 * ask the OS to stay awake via SetThreadExecutionState. That state only persists
 * as long as the calling thread is alive, so we spawn a small PowerShell helper
 * that sets it once and then blocks — killing that helper releases the lock.
 * The helper also polls its parent PID and self-exits if this server ever dies
 * without a clean shutdown, so a crash can't strand the machine awake forever.
 * It checks the parent's start time too, not just its PID — Windows recycles
 * PIDs, so a bare PID-exists check can be fooled into thinking a long-dead
 * parent is still alive once some unrelated later process reuses that number.
 */
const { spawn } = require('child_process');

let child = null;

function acquire() {
  if (process.platform !== 'win32' || child) return;
  const ES_CONTINUOUS = 0x80000000;
  const ES_SYSTEM_REQUIRED = 0x00000001;
  // Approximates this process's own start time (epoch ms) without an extra
  // subprocess call — process.uptime() has been ticking since Node launched.
  const parentStartedAt = Date.now() - Math.round(process.uptime() * 1000);
  const script = [
    'Add-Type -Namespace Win32 -Name Power -MemberDefinition',
    "'[DllImport(\"kernel32.dll\", SetLastError = true)] public static extern uint SetThreadExecutionState(uint esFlags);';",
    `[Win32.Power]::SetThreadExecutionState(${ES_CONTINUOUS} -bor ${ES_SYSTEM_REQUIRED}) | Out-Null;`,
    `$parent = ${process.pid}; $parentStart = ${parentStartedAt}; $epoch = Get-Date '1970-01-01Z';`,
    'while ($true) {',
    '  Start-Sleep -Seconds 15;',
    '  $p = Get-Process -Id $parent -ErrorAction SilentlyContinue;',
    '  if (-not $p) { break }',
    '  $startMs = [long](($p.StartTime.ToUniversalTime() - $epoch).TotalMilliseconds);',
    '  if ([Math]::Abs($startMs - $parentStart) -gt 5000) { break }',
    '}',
  ].join(' ');
  try {
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: 'ignore',
    });
    child.on('exit', () => { child = null; });
    child.on('error', () => { child = null; });
  } catch {
    child = null;
  }
}

function release() {
  if (!child) return;
  try { child.kill(); } catch {}
  child = null;
}

module.exports = { acquire, release };
