/* Token/cost usage for a session's current conversation — read from Claude's
 * own transcript JSONL (the same files `hasClaudeHistory` in claude.js checks),
 * not tracked by us. Picks the most recently modified transcript for the folder
 * and sums `message.usage` across unique assistant message ids.
 */
const fs = require('fs');
const path = require('path');
const { claudeProjectDir } = require('./claude');

// Per-MTok rates. Cache write/read are derived from the input rate using the
// standard 5-minute-TTL multipliers (write 1.25x, read 0.1x) — an approximation
// good enough for a cost estimate badge, not a billing-accurate figure.
const RATES = {
  opus: { input: 5, output: 25 },
  sonnet: { input: 3, output: 15 },
  haiku: { input: 1, output: 5 },
};

function ratesFor(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('opus')) return RATES.opus;
  if (m.includes('haiku')) return RATES.haiku;
  return RATES.sonnet;
}

// Most recently modified *.jsonl in a folder, or null.
function latestTranscript(dir) {
  let latest = null;
  let latestMtime = -1;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const full = path.join(dir, f);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.mtimeMs > latestMtime) { latestMtime = stat.mtimeMs; latest = full; }
  }
  return latest;
}

// Sum usage across the current conversation for `cwd`. Returns null if there's
// no transcript yet or it can't be read/parsed.
function readUsage(cwd) {
  try {
    const dir = claudeProjectDir(cwd);
    if (!fs.existsSync(dir)) return null;
    const file = latestTranscript(dir);
    if (!file) return null;

    const seen = new Set();
    let input = 0, output = 0, cacheRead = 0, cacheCreation = 0, model = null;

    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      const msg = entry && entry.message;
      if (!msg || !msg.usage) continue;
      const id = msg.id || `${entry.type}-${i}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const u = msg.usage;
      input += u.input_tokens || 0;
      output += u.output_tokens || 0;
      cacheRead += u.cache_read_input_tokens || 0;
      cacheCreation += u.cache_creation_input_tokens || 0;
      if (msg.model) model = msg.model;
    }

    if (!seen.size) return null;
    const rates = ratesFor(model);
    const costUSD =
      (input * rates.input + output * rates.output +
        cacheCreation * rates.input * 1.25 + cacheRead * rates.input * 0.1) / 1e6;

    return { input, output, cacheRead, cacheCreation, costUSD, model };
  } catch {
    return null;
  }
}

module.exports = { readUsage };
