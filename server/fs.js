/* Folder browser — list drives + immediate subfolders. Ported from the old
 * server.js GET /api/dirs logic (lines ~161-192).
 */
const fs = require('fs');
const path = require('path');

// Returns { path, parent, dirs:[{name,path}] } for `target`.
//   - '__drives__' enumerates drive letters (C..Z) on Windows, or '/' elsewhere.
//   - otherwise lists immediate subdirectories of the resolved absolute path,
//     hiding Windows system junk (names starting with '$').
// `currentCwd` is used as the default when `target` is falsy.
function listDir(target, currentCwd) {
  target = target ? String(target) : currentCwd;

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
    return { path: '__drives__', parent: null, dirs: drives };
  }

  const abs = path.resolve(target);
  const entries = fs.readdirSync(abs, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .filter(d => !d.name.startsWith('$')) // hide windows system junk
    .map(d => ({ name: d.name, path: path.join(abs, d.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const parent = path.dirname(abs);
  return {
    path: abs,
    parent: parent === abs ? '__drives__' : parent,
    dirs: entries,
  };
}

module.exports = { listDir };
