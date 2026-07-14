/* Git sync — clone (into an empty folder) or pull (into an existing repo) the
 * configured GitHub repo, streaming output via onData. Ported from old
 * server.js lines ~88-147.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { loadConfig } = require('./config');

// Run a git command, streaming both stdout and stderr to onData. Resolves with
// { code }. Never rejects. GIT_TERMINAL_PROMPT=0 makes git fail (not hang) when
// credentials are missing.
function runGit(args, cwd, onData) {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    child.stdout.on('data', d => onData(d.toString()));
    child.stderr.on('data', d => onData(d.toString())); // git writes progress here
    child.on('error', (err) => {
      onData('git error: ' + err.message + '\n');
      resolve({ code: -1 });
    });
    child.on('close', (code) => resolve({ code }));
  });
}

// Clone (into an empty folder) or pull (into an existing repo) the configured
// GitHub repo. Streams output via onData. Resolves with { ok, message }.
//
// `cfg` may be passed in; otherwise the current config.json is read fresh so we
// honor any changes the user made in Settings since startup.
async function syncRepo(cwd, onData, cfg) {
  const config = cfg || loadConfig();

  if (!config.repoUrl) {
    onData('No GitHub repo configured. Set one in Settings.\n');
    return { ok: false, message: 'no repo configured' };
  }

  const isRepo = fs.existsSync(path.join(cwd, '.git'));

  if (!isRepo) {
    // Only clone into an empty (or non-existent) folder.
    const isEmpty = fs.existsSync(cwd)
      ? fs.readdirSync(cwd).filter(n => n !== '.claude-web-images').length === 0
      : true;
    if (!isEmpty) {
      onData(
        "Can't clone into a non-empty folder that isn't already a git repo.\n" +
        'Choose an empty folder, or open a folder that already contains the repo.\n'
      );
      return { ok: false, message: 'folder not empty' };
    }
    fs.mkdirSync(cwd, { recursive: true });
    onData(`Cloning ${config.repoUrl} ...\n`);
    const args = ['clone', ...(config.branch ? ['--branch', config.branch] : []), config.repoUrl, cwd];
    const { code } = await runGit(args, path.dirname(cwd), onData);
    return { ok: code === 0, message: code === 0 ? 'cloned' : 'clone failed' };
  }

  // Existing repo: pull latest.
  onData('Fetching + pulling latest...\n');
  const { code } = await runGit(['pull', '--ff-only'], cwd, onData);
  if (code !== 0) {
    onData(
      'Pull failed (local changes or a non-fast-forward).\n' +
      'Resolve the issue in this folder, then sync again.\n'
    );
  }
  return { ok: code === 0, message: code === 0 ? 'up to date' : 'pull failed' };
}

// Clone-or-pull a fixed LIST of repos into their own subfolders of `workDir`,
// independent of any session's cwd — e.g. a NocVault-style workspace root
// containing several sibling repo checkouts. Streams progress via onData.
// Resolves with { ok, message } — ok is false if any repo failed, but every
// repo is still attempted (one bad repo shouldn't block the rest).
async function syncAllRepos(workDir, repos, onData) {
  if (!workDir) {
    onData('No workspace folder configured. Set one in Settings.\n');
    return { ok: false, message: 'no workspace folder configured' };
  }
  if (!Array.isArray(repos) || repos.length === 0) {
    onData('No repos configured. Add one in Settings.\n');
    return { ok: false, message: 'no repos configured' };
  }

  fs.mkdirSync(workDir, { recursive: true });
  let anyFailed = false;

  for (const repo of repos) {
    const name = String(repo?.name || '').trim();
    const url = String(repo?.url || '').trim();
    if (!name || !url) {
      onData('Skipping a repo with a missing name or URL.\n');
      anyFailed = true;
      continue;
    }
    const dest = path.join(workDir, name);
    onData(`\n[${name}] `);

    if (fs.existsSync(path.join(dest, '.git'))) {
      onData('pulling latest...\n');
      const { code } = await runGit(['pull', '--ff-only'], dest, onData);
      if (code !== 0) { onData(`[${name}] pull failed.\n`); anyFailed = true; }
      else onData(`[${name}] up to date.\n`);
    } else if (fs.existsSync(dest) && fs.readdirSync(dest).length > 0) {
      onData("folder exists and isn't empty or a git repo — skipping.\n");
      anyFailed = true;
    } else {
      onData('cloning...\n');
      const args = ['clone', ...(repo.branch ? ['--branch', repo.branch] : []), url, dest];
      const { code } = await runGit(args, workDir, onData);
      if (code !== 0) { onData(`[${name}] clone failed.\n`); anyFailed = true; }
      else onData(`[${name}] cloned.\n`);
    }
  }

  return { ok: !anyFailed, message: anyFailed ? 'some repos failed' : 'all repos synced' };
}

// Collect (not stream) a working-tree diff summary for `cwd`. Resolves with
// { ok, isRepo, files:[{path,status,added,removed}], patch }.
function collectGit(args, cwd) {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn('git', args, { cwd });
    child.stdout.on('data', d => { out += d.toString(); });
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(out));
  });
}

async function gitDiff(cwd) {
  if (!fs.existsSync(path.join(cwd, '.git'))) {
    return { ok: true, isRepo: false, files: [], patch: '' };
  }

  const numstat = await collectGit(['diff', 'HEAD', '--numstat'], cwd);
  const status = await collectGit(['status', '--porcelain=v1'], cwd);
  const patch = await collectGit(['diff', 'HEAD'], cwd);

  const statusByPath = new Map();
  for (const line of status.split('\n')) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2).trim();
    const file = line.slice(3).trim();
    statusByPath.set(file, code || '?');
  }

  const files = [];
  const seen = new Set();
  for (const line of numstat.split('\n')) {
    if (!line.trim()) continue;
    const [added, removed, file] = line.split('\t');
    seen.add(file);
    files.push({
      path: file,
      status: statusByPath.get(file) || 'M',
      added: added === '-' ? 0 : parseInt(added, 10) || 0,
      removed: removed === '-' ? 0 : parseInt(removed, 10) || 0,
    });
  }
  // Untracked files never show up in `diff HEAD --numstat` — add them from
  // status so new files aren't silently missing from the panel.
  for (const [file, code] of statusByPath) {
    if (code === '??' && !seen.has(file)) {
      files.push({ path: file, status: code, added: 0, removed: 0 });
    }
  }

  return { ok: true, isRepo: true, files, patch };
}

module.exports = { runGit, syncRepo, syncAllRepos, gitDiff };
