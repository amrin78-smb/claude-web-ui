/* Folder browser — list drives + immediate subfolders. Ported from the old
 * server.js GET /api/dirs logic (lines ~161-192).
 */
const fs = require('fs');
const path = require('path');

// Returns { path, parent, dirs:[{name,path}], files:[{name,path,bytes}] } for
// `target`.
//   - '__drives__' enumerates drive letters (C..Z) on Windows, or '/' elsewhere.
//   - otherwise lists immediate subdirectories of the resolved absolute path,
//     hiding Windows system junk (names starting with '$').
// `currentCwd` is used as the default when `target` is falsy.
//
// `opts.fileExt` (e.g. '.zip') additionally lists matching FILES, so the same
// browser can be used to pick a backup archive rather than only a folder.
// `files` is always present — an empty array when no extension was asked for —
// so a caller never has to guard on it.
function listDir(target, currentCwd, opts = {}) {
  target = target ? String(target) : currentCwd;
  const ext = opts.fileExt ? String(opts.fileExt).toLowerCase() : '';

  if (target === '__drives__') {
    // On Windows enumerate drive letters; elsewhere just use root.
    const drives = [];
    if (process.platform === 'win32') {
      for (let i = 67; i <= 90; i++) { // C..Z
        const letter = String.fromCharCode(i) + ':\\';
        if (fs.existsSync(letter)) drives.push({ name: letter, path: letter });
      }
    } else {
      drives.push({ name: '/', path: '/' });
    }
    return { path: '__drives__', parent: null, dirs: drives, files: [] };
  }

  const abs = path.resolve(target);
  const all = fs.readdirSync(abs, { withFileTypes: true })
    .filter(d => !d.name.startsWith('$')); // hide windows system junk

  const dirs = all
    .filter(d => d.isDirectory())
    .map(d => ({ name: d.name, path: path.join(abs, d.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const files = !ext ? [] : all
    .filter(d => d.isFile() && d.name.toLowerCase().endsWith(ext))
    .map((d) => {
      const full = path.join(abs, d.name);
      // Size is shown next to the name; a file that vanishes between readdir
      // and stat shouldn't drop the whole listing.
      let bytes = 0;
      try { bytes = fs.statSync(full).size; } catch { /* ignore */ }
      return { name: d.name, path: full, bytes };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const parent = path.dirname(abs);
  return {
    path: abs,
    parent: parent === abs ? '__drives__' : parent,
    dirs,
    files,
  };
}

module.exports = { listDir };
