#!/usr/bin/env node
/* Assemble a self-contained, runnable app tree for one platform.
 *
 * This is the shared first stage for both installers: the .exe (Inno Setup)
 * and the .deb just wrap whatever this produces. Keeping it separate means the
 * layout can be built and RUN locally, on any host, without either toolchain.
 *
 * What ships is much smaller than the repo: server/ (minus tests), web/dist,
 * and four runtime dependencies. Vite/Svelte/Rollup are devDependencies used to
 * produce web/dist — they never travel.
 *
 * Cross-building works because the one native dependency, @lydell/node-pty,
 * publishes per-platform prebuilds as optional deps. `npm install --os --cpu`
 * picks the right one, so a Linux tree can be staged from Windows with no
 * compiler, no Docker and no WSL.
 *
 *   node scripts/package.js --target linux-x64
 *   node scripts/package.js --target win32-x64 --skip-build
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const APP_ROOT = path.join(__dirname, '..');

const TARGETS = {
  'win32-x64': { os: 'win32', cpu: 'x64' },
  'win32-arm64': { os: 'win32', cpu: 'arm64' },
  'linux-x64': { os: 'linux', cpu: 'x64' },
  'linux-arm64': { os: 'linux', cpu: 'arm64' },
};

// Launchers are platform-specific; everything else is shared. These are copied
// verbatim from the repo root — they already resolve their own directory, so
// they work unchanged from wherever the installer puts them.
const LAUNCHERS = {
  win32: ['Start Claude Web.bat', 'Start Claude Web (Background).vbs', 'Stop Claude Web.bat'],
  linux: ['start-claude-web.sh', 'stop-claude-web.sh'],
};

const SHARED = ['README.md'];

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
}
const hasFlag = (name) => process.argv.includes('--' + name);

function run(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
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

function main() {
  const target = arg('target', `${process.platform}-${process.arch}`);
  const spec = TARGETS[target];
  if (!spec) {
    console.error(`Unknown --target "${target}". One of: ${Object.keys(TARGETS).join(', ')}`);
    process.exit(1);
  }
  const outDir = path.resolve(arg('out', path.join(APP_ROOT, 'dist-pkg', target)));
  const pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'));

  console.log(`\nPackaging ${pkg.name} ${pkg.version} for ${target}`);
  console.log(`  -> ${outDir}\n`);

  // 1. Frontend. web/dist is what the server serves in production; without it
  //    the packaged app would fall back to "dev — served by Vite" and 404.
  if (hasFlag('skip-build')) {
    if (!fs.existsSync(path.join(APP_ROOT, 'web', 'dist', 'index.html'))) {
      console.error('--skip-build given but web/dist/index.html does not exist.');
      process.exit(1);
    }
    console.log('[1/5] frontend: reusing existing web/dist');
  } else {
    console.log('[1/5] building frontend…');
    run('npm', ['run', 'build'], APP_ROOT);
  }

  // 2. Clean staging dir.
  console.log('[2/5] staging files…');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  // server/, minus the test files — they pull in vitest, which isn't shipped.
  fs.cpSync(path.join(APP_ROOT, 'server'), path.join(outDir, 'server'), {
    recursive: true,
    filter: (src) => !src.endsWith('.test.js'),
  });
  fs.cpSync(path.join(APP_ROOT, 'web', 'dist'), path.join(outDir, 'web', 'dist'), { recursive: true });

  for (const name of [...(LAUNCHERS[spec.os] || []), ...SHARED]) {
    const src = path.join(APP_ROOT, name);
    if (!fs.existsSync(src)) { console.warn(`  ! missing, skipped: ${name}`); continue; }
    fs.copyFileSync(src, path.join(outDir, name));
    if (name.endsWith('.sh')) fs.chmodSync(path.join(outDir, name), 0o755);
  }

  // 3. A production package.json: no devDependencies, no build scripts that
  //    would need tooling absent from the installed app.
  const shipped = {
    name: pkg.name,
    version: pkg.version,
    private: true,
    description: pkg.description,
    main: pkg.main,
    scripts: { start: 'node server/index.js' },
    dependencies: pkg.dependencies,
  };
  fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify(shipped, null, 2) + '\n');

  // 4. Runtime dependencies for the TARGET platform, not this one. --os/--cpu
  //    steer optional-dependency resolution, which is how node-pty's prebuild
  //    is selected; --ignore-scripts because no install hook should run against
  //    a foreign platform (and none of these four need one).
  console.log(`[3/5] installing runtime deps for ${spec.os}/${spec.cpu}…`);
  run('npm', [
    'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund',
    `--os=${spec.os}`, `--cpu=${spec.cpu}`,
  ], outDir);
  fs.rmSync(path.join(outDir, 'package-lock.json'), { force: true });

  // 5. Mark this as a packaged install. The app has two update paths, chosen
  //    here rather than guessed at runtime: a git checkout pulls and rebuilds
  //    itself, a packaged install can't (no .git, and often no write access to
  //    the install dir) and defers to the release feed instead.
  console.log('[4/5] writing install marker…');
  fs.writeFileSync(path.join(outDir, 'install-mode.json'), JSON.stringify({
    mode: 'packaged',
    target,
    version: pkg.version,
    builtAt: new Date().toISOString(),
    builtOn: `${process.platform}-${process.arch}`,
  }, null, 2) + '\n');

  // 6. Sanity: the prebuild that actually landed must match the target, or the
  //    app will die at first spawn on the user's machine rather than here.
  console.log('[5/5] verifying…');
  const ptyDir = path.join(outDir, 'node_modules', '@lydell');
  const variants = fs.existsSync(ptyDir)
    ? fs.readdirSync(ptyDir).filter((d) => d !== 'node-pty')
    : [];
  const expected = `node-pty-${spec.os}-${spec.cpu}`;
  if (!variants.includes(expected)) {
    console.error(`\n  FAILED: expected ${expected}, found [${variants.join(', ') || 'none'}]`);
    console.error('  The packaged app would not be able to spawn a terminal.');
    process.exit(1);
  }
  if (!fs.existsSync(path.join(outDir, 'web', 'dist', 'index.html'))) {
    console.error('\n  FAILED: web/dist/index.html missing from the staged tree.');
    process.exit(1);
  }

  const mb = (dirSize(outDir) / 1024 / 1024).toFixed(1);
  console.log(`\n  ok — ${expected}, web/dist present, ${mb} MB total`);
  console.log(`  run it with:  node server/index.js   (from ${outDir})\n`);
}

main();
