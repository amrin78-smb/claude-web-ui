// Throwaway: exercise the full PTY lifecycle (create -> stream -> restart -> stream -> close).
const WebSocket = require('ws');
const os = require('os');
const ws = new WebSocket('ws://127.0.0.1:4281/ws');
let id = null;
let dataBeforeRestart = 0, dataAfterRestart = 0, restarted = false, closed = false;
const log = (...a) => console.log(...a);
const done = (code, msg) => { log(msg); try { ws.close(); } catch {} process.exit(code); };
const fail = setTimeout(() => done(2, 'TIMEOUT: ' + JSON.stringify({ id, dataBeforeRestart, restarted, dataAfterRestart, closed })), 25000);

ws.on('open', () => ws.send(JSON.stringify({ type: 'create', cwd: os.homedir(), cols: 100, rows: 30 })));
ws.on('error', (e) => done(1, 'WS ERROR: ' + e.message));
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === 'created') { id = m.session.id; log('created:', id, m.session.status); }
  else if (m.type === 'data' && m.id === id) {
    if (!restarted) {
      dataBeforeRestart += m.data.length;
      if (dataBeforeRestart > 50 && !restarted) {
        restarted = true;
        log('spawn streamed', dataBeforeRestart, 'bytes -> sending restart (respawn path)');
        setTimeout(() => ws.send(JSON.stringify({ type: 'restart', id, cols: 100, rows: 30 })), 300);
      }
    } else {
      dataAfterRestart += m.data.length;
      if (dataAfterRestart > 50 && !closed) {
        closed = true;
        log('respawn streamed', dataAfterRestart, 'bytes (session survived restart) -> closing');
        setTimeout(() => ws.send(JSON.stringify({ type: 'close', id })), 300);
      }
    }
  }
  else if (m.type === 'closed' && m.id === id) {
    clearTimeout(fail);
    done(0, 'OK: create -> stream -> restart -> stream -> close all worked');
  }
});
