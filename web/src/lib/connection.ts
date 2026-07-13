// Reconnecting WebSocket client (singleton `conn`).
//
// The server keeps PTY sessions alive independently of any socket, so when the
// page reloads or the laptop wakes, we just reconnect and re-`list` — the running
// Claude sessions are still there. Messages sent while disconnected are queued.

type Msg = any;
type Handler = (m: Msg) => void;
type StatusHandler = (s: ConnStatus) => void;
export type ConnStatus = 'connecting' | 'connected' | 'disconnected';

class Connection {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private statusHandlers = new Set<StatusHandler>();
  private queue: Msg[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  status: ConnStatus = 'connecting';

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.setStatus('connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.setStatus('connected');
      this.flush();
    };
    ws.onclose = () => {
      this.setStatus('disconnected');
      this.scheduleReconnect();
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
    ws.onmessage = (ev) => {
      let m: Msg;
      try { m = JSON.parse(ev.data); } catch { return; }
      this.handlers.forEach((h) => h(m));
    };
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 1200);
  }

  private setStatus(s: ConnStatus) {
    this.status = s;
    this.statusHandlers.forEach((f) => f(s));
  }

  private flush() {
    const q = this.queue;
    this.queue = [];
    q.forEach((m) => this.send(m));
  }

  send(m: Msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(m));
    } else {
      this.queue.push(m);
    }
  }

  /** Subscribe to all inbound messages. Returns an unsubscribe fn. */
  on(h: Handler): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  /** Subscribe to connection-status changes (fires immediately with current). */
  onStatus(f: StatusHandler): () => void {
    this.statusHandlers.add(f);
    f(this.status);
    return () => this.statusHandlers.delete(f);
  }
}

export const conn = new Connection();
