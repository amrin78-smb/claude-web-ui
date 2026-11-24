// Web Push on this device: subscribe/unsubscribe with the server (server/push.js)
// so alerts arrive even when the app is closed. The service worker
// (public/sw.js) shows them. Per device and per origin: the laptop and the
// phone each subscribe, and so do localhost and the remote hostname.
import { writable } from 'svelte/store';
import { setActive, sessions } from '../stores/sessions';

export type PushState = 'unsupported' | 'needs-install' | 'denied' | 'off' | 'on' | 'busy';
export const pushState = writable<PushState>('off');

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = window.matchMedia('(display-mode: standalone)').matches ||
  (navigator as any).standalone === true;

// The page's own system notifications defer to push on a device that has it,
// or every alert would arrive twice. Read synchronously by lib/notify.ts.
export function pushIsOn(): boolean {
  try { return localStorage.getItem('pushEndpoint') !== null; } catch { return false; }
}
function remember(endpoint: string | null) {
  try {
    if (endpoint) localStorage.setItem('pushEndpoint', endpoint);
    else localStorage.removeItem('pushEndpoint');
  } catch {}
}

function supported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function post(path: string, body: unknown): Promise<any> {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

function deviceLabel(): string {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua) ? 'Android' : isIOS ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'browser';
  return `${browser} on ${os} (${location.host})`;
}

// Work out where this device stands, quietly, at startup.
export async function refreshPush(): Promise<void> {
  if (!supported()) {
    pushState.set(isIOS && !standalone ? 'needs-install' : 'unsupported');
    return;
  }
  if (Notification.permission === 'denied') { pushState.set('denied'); remember(null); return; }
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) { pushState.set('off'); remember(null); return; }
    // The browser may hold a subscription the server dropped (a 410, or a
    // server reinstalled with new keys): only "on" if both sides agree.
    const { subscribed } = await post('/api/push/status', { endpoint: sub.endpoint });
    if (!subscribed) await post('/api/push/subscribe', { subscription: sub.toJSON(), label: deviceLabel() });
    remember(sub.endpoint);
    pushState.set('on');
  } catch {
    pushState.set('off');
  }
}

export async function enablePush(): Promise<string | null> {
  pushState.set('busy');
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { pushState.set(perm === 'denied' ? 'denied' : 'off'); return 'Notifications were not allowed.'; }
    const reg = await navigator.serviceWorker.ready;
    const { publicKey } = await (await fetch('/api/push/key')).json();
    let sub = await reg.pushManager.getSubscription();
    // A subscription made with another server key can't be reused.
    if (sub) await sub.unsubscribe();
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
    await post('/api/push/subscribe', { subscription: sub.toJSON(), label: deviceLabel() });
    remember(sub.endpoint);
    pushState.set('on');
    return null;
  } catch (err) {
    pushState.set('off');
    return (err as Error).message || 'Could not turn on push.';
  }
}

export async function disablePush(): Promise<void> {
  pushState.set('busy');
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await post('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe();
    }
  } finally {
    remember(null);
    pushState.set('off');
  }
}

export async function testPush(): Promise<string | null> {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return 'This device is not subscribed.';
    const r = await post('/api/push/test', { endpoint: sub.endpoint });
    return r.ok ? null : 'The push service refused it.';
  } catch (err) {
    return (err as Error).message;
  }
}

// Opening the app from an alert: the service worker either opens /?session=…
// or messages a window that's already open.
function openSession(id: string) {
  if (id) setActive(id);
}
const fromUrl = new URLSearchParams(location.search).get('session');
if (fromUrl) {
  // Select it once the session list has it (before that, the list's own
  // "keep a valid selection" logic would undo us), then drop the parameter so
  // a reload doesn't keep jumping back to it.
  history.replaceState(null, '', location.pathname);
  let done = false;
  const stop = sessions.subscribe((list) => {
    if (done || !list.some((s) => s.id === fromUrl)) return;
    done = true;
    openSession(fromUrl);
    queueMicrotask(() => stop());
  });
  setTimeout(() => { if (!done) { done = true; stop(); } }, 15000);
}
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'open-session') openSession(String(e.data.session || ''));
  });
}

refreshPush();
