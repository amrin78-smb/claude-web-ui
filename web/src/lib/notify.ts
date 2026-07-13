import { writable, get } from 'svelte/store';
import { conn } from './connection';
import { activeId, setActive } from '../stores/sessions';
import { toast } from '../stores/ui';

const storedNotifications = localStorage.getItem('notifications') === '1';
const storedSound = localStorage.getItem('soundEnabled') === '1';

export const notificationsEnabled = writable<boolean>(storedNotifications);
export const soundEnabled = writable<boolean>(storedSound);

notificationsEnabled.subscribe((v) => localStorage.setItem('notifications', v ? '1' : '0'));
soundEnabled.subscribe((v) => localStorage.setItem('soundEnabled', v ? '1' : '0'));

export async function requestNotifications(): Promise<void> {
  if (typeof Notification === 'undefined') return;
  const perm = await Notification.requestPermission();
  notificationsEnabled.set(perm === 'granted');
}

export const pendingCount = writable<number>(0);

export function clearPending() {
  pendingCount.set(0);
}

window.addEventListener('focus', clearPending);

function playBeep() {
  try {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 800;
    osc.connect(gain);
    gain.connect(ctx.destination);
    // Ramp the gain down instead of stopping abruptly, to avoid a click/pop.
    gain.gain.setValueAtTime(gain.gain.value || 0.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.15);
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
    osc.onended = () => ctx.close();
  } catch {
    // Audio can throw under autoplay-policy restrictions; never crash the app for it.
  }
}

export function notifyIdle(opts: { id: string; title: string; preview: string; active: boolean }): void {
  // The user is already watching this session, so any notification would be noise.
  if (opts.active) return;

  toast('✅ ' + opts.title + ' finished');
  pendingCount.update((n) => n + 1);

  if (
    get(notificationsEnabled) &&
    typeof Notification !== 'undefined' &&
    Notification.permission === 'granted'
  ) {
    const n = new Notification('Claude finished — ' + opts.title, { body: opts.preview });
    n.onclick = () => {
      setActive(opts.id);
      window.focus();
      n.close();
    };
  }

  if (get(soundEnabled)) playBeep();
}

conn.on((m) => {
  if (m.type === 'idle') {
    const active = get(activeId) === m.id && document.visibilityState === 'visible';
    notifyIdle({ id: m.id, title: m.title, preview: m.preview, active });
  }
});
