#!/usr/bin/env node
/* Build a .deb from a staged Linux tree (see scripts/package.js).
 *
 * A .deb is just an `ar` archive with three members, in this exact order:
 *   debian-binary   the literal "2.0\n"
 *   control.tar.gz  package metadata + maintainer scripts
 *   data.tar.gz     the files, paths relative to /
 *
 * The tarballs are made with GNU tar (present on this machine and on any CI
 * runner) so ownership and permissions come out right; `ar` itself is ~40 lines
 * and written here, which means no dpkg-deb, no Docker and no WSL — this builds
 * the same way on Windows as it does on a Debian box.
 *
 *   node scripts/build-deb.js --stage dist-pkg/linux-x64 --out dist-pkg
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const APP_ROOT = path.join(__dirname, '..');
const INSTALL_DIR = '/opt/claude-web-ui';

const DEB_ARCH = { 'linux-x64': 'amd64', 'linux-arm64': 'arm64' };

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
}

// ---------------------------------------------------------------- ar writer

// One `ar` member: a 60-byte fixed header then the payload, padded to an even
// length. Debian uses plain space-padded names (not GNU's "name/" convention).
function arMember(name, data) {
  const pad = (s, n) => String(s).padEnd(n, ' ').slice(0, n);
  const header = Buffer.from(
    pad(name, 16) +          // name
    pad('0', 12) +           // mtime — fixed, so builds are reproducible
    pad('0', 6) +            // owner uid
    pad('0', 6) +            // group gid
    pad('100644', 8) +       // mode
    pad(String(data.length), 10) +
    '`\n',                   // magic
    'ascii'
  );
  const parts = [header, data];
  if (data.length % 2 === 1) parts.push(Buffer.from('\n', 'ascii'));
  return Buffer.concat(parts);
}

function writeAr(outFile, members) {
  const chunks = [Buffer.from('!<arch>\n', 'ascii')];
  for (const [name, data] of members) chunks.push(arMember(name, data));
  fs.writeFileSync(outFile, Buffer.concat(chunks));
}

// --------------------------------------------------------------- tar helper

// GNU tar, forcing root ownership: files installed by dpkg belong to root, and
// whatever uid happens to own the staging directory is irrelevant.
function tarGz(cwd, entries, outFile) {
  // GNU tar reads "C:path" as host:path and tries to reach a machine called
  // "C". --force-local says the colon is part of a local filename; forward
  // slashes keep the MSYS build happy on top of that.
  const posix = (p) => p.split(String.fromCharCode(92)).join('/');
  execFileSync('tar', [
    '--create', '--gzip', '--force-local', '--file', posix(outFile),
    '--owner=root', '--group=root', '--numeric-owner',
    '--mtime=@0',           // reproducible
    '--format=gnu',
    '--directory', posix(cwd),
    ...entries,
  ], { stdio: ['ignore', 'ignore', 'inherit'] });
  return fs.readFileSync(outFile);
}

// --------------------------------------------------------------------- main

function main() {
  const stage = path.resolve(arg('stage', path.join(APP_ROOT, 'dist-pkg', 'linux-x64')));
  const outDir = path.resolve(arg('out', path.join(APP_ROOT, 'dist-pkg')));

  const markerPath = path.join(stage, 'install-mode.json');
  if (!fs.existsSync(markerPath)) {
    console.error(`No install-mode.json in ${stage} — run scripts/package.js first.`);
    process.exit(1);
  }
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  const arch = DEB_ARCH[marker.target];
  if (!arch) {
    console.error(`${marker.target} is not a Linux target — nothing to package as a .deb.`);
    process.exit(1);
  }
  const version = marker.version;
  const debName = `claude-web-ui_${version}_${arch}.deb`;

  console.log(`\nBuilding ${debName} from ${stage}\n`);

  const work = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cwui-deb-'));
  const root = path.join(work, 'root');
  const ctrl = path.join(work, 'control');
  fs.mkdirSync(path.join(root, 'opt', 'claude-web-ui'), { recursive: true });
  fs.mkdirSync(path.join(root, 'usr', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'usr', 'share', 'applications'), { recursive: true });
  fs.mkdirSync(path.join(root, 'usr', 'lib', 'systemd', 'user'), { recursive: true });
  fs.mkdirSync(ctrl, { recursive: true });

  // --- payload: the staged app, verbatim
  console.log('[1/4] laying out the filesystem…');
  fs.cpSync(stage, path.join(root, 'opt', 'claude-web-ui'), { recursive: true });

  // A launcher on PATH. Checks Node up front so a missing/old runtime produces
  // a sentence rather than a stack trace.
  const wrapper = `#!/bin/sh
# Launcher for Claude Code Web UI (installed under ${INSTALL_DIR}).
if ! command -v node >/dev/null 2>&1; then
  echo "claude-web-ui: Node.js is required but 'node' was not found on PATH." >&2
  echo "Install Node.js 18 or newer, then run this again." >&2
  exit 1
fi
MAJOR=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
if [ "$MAJOR" -lt 18 ]; then
  echo "claude-web-ui: Node.js 18 or newer is required (found $(node -v))." >&2
  exit 1
fi
cd ${INSTALL_DIR} || exit 1
exec node server/index.js "$@"
`;
  fs.writeFileSync(path.join(root, 'usr', 'bin', 'claude-web-ui'), wrapper, { mode: 0o755 });

  fs.writeFileSync(path.join(root, 'usr', 'share', 'applications', 'claude-web-ui.desktop'),
    `[Desktop Entry]
Type=Application
Name=Claude Code Web UI
Comment=Run Claude Code in your browser
Exec=/usr/bin/claude-web-ui
Terminal=false
Categories=Development;
Keywords=claude;ai;terminal;
`);

  // A *user* service, not system-wide: the app runs as you, spawns Claude as
  // you, and reads your ~/.claude. Running it as root would be wrong.
  fs.writeFileSync(path.join(root, 'usr', 'lib', 'systemd', 'user', 'claude-web-ui.service'),
    `[Unit]
Description=Claude Code Web UI
Documentation=https://github.com/amrin78-smb/claude-web-ui
After=network.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
ExecStart=/usr/bin/claude-web-ui
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`);

  // --- control metadata
  console.log('[2/4] writing control metadata…');
  const installedKb = Math.max(1, Math.round(dirSize(root) / 1024));
  fs.writeFileSync(path.join(ctrl, 'control'),
    `Package: claude-web-ui
Version: ${version}
Section: devel
Priority: optional
Architecture: ${arch}
Depends: nodejs (>= 18)
Maintainer: amrin78 <amrin78@gmail.com>
Installed-Size: ${installedKb}
Homepage: https://github.com/amrin78-smb/claude-web-ui
Description: Run Claude Code in your browser
 Local web app that runs the Claude Code CLI inside a real PTY, streamed to a
 browser tab over WebSocket. Multi-session, and sessions survive both a page
 reload and a server restart.
 .
 Start it with "claude-web-ui", or enable the bundled user service:
 systemctl --user enable --now claude-web-ui
`);

  fs.writeFileSync(path.join(ctrl, 'postinst'),
    `#!/bin/sh
set -e
if [ "$1" = "configure" ]; then
  echo "claude-web-ui installed to ${INSTALL_DIR}."
  echo "  Run it:        claude-web-ui        (then open http://127.0.0.1:4280)"
  echo "  Or as a service: systemctl --user enable --now claude-web-ui"
  if ! command -v claude >/dev/null 2>&1; then
    echo
    echo "  Note: the Claude CLI was not found on PATH. Install it with:"
    echo "    npm install -g @anthropic-ai/claude-code"
  fi
fi
exit 0
`, { mode: 0o755 });

  fs.writeFileSync(path.join(ctrl, 'prerm'),
    `#!/bin/sh
set -e
# Stop the user service if it's running, so removal doesn't leave a server
# holding port 4280. Failure here must not block removal.
if [ "$1" = "remove" ] || [ "$1" = "upgrade" ]; then
  systemctl --user stop claude-web-ui.service >/dev/null 2>&1 || true
fi
exit 0
`, { mode: 0o755 });

  // --- assemble
  console.log('[3/4] building tarballs…');
  const dataTar = tarGz(root, ['.'], path.join(work, 'data.tar.gz'));
  const ctrlTar = tarGz(ctrl, ['.'], path.join(work, 'control.tar.gz'));

  console.log('[4/4] writing the ar archive…');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, debName);
  writeAr(outFile, [
    ['debian-binary', Buffer.from('2.0\n', 'ascii')],
    ['control.tar.gz', ctrlTar],
    ['data.tar.gz', dataTar],
  ]);

  fs.rmSync(work, { recursive: true, force: true });
  const mb = (fs.statSync(outFile).size / 1024 / 1024).toFixed(1);
  console.log(`\n  ok — ${outFile} (${mb} MB, ${arch})`);
  console.log(`  install with:  sudo apt install ./${debName}\n`);
}

function dirSize(dir) {
  let bytes = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) bytes += dirSize(full);
    else bytes += fs.statSync(full).size;
  }
  return bytes;
}

module.exports = { arMember, writeAr };

if (require.main === module) main();
