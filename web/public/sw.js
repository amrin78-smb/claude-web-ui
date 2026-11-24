// Service worker: makes the Web UI installable as an app, and shows push
// alerts ("Claude needs you", "Claude finished") when no page is in front.
//
// Deliberately caches nothing: the page is a live view of sessions on one
// machine, so an offline copy would only show stale state, and the server
// already marks index.html no-store so an upgrade is picked up on next load.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Safari (and every iOS home-screen app) may revoke a subscription whose
// pushes don't show a notification, so there we always show one.
const MUST_SHOW = /Safari/.test(self.navigator.userAgent) && !/Chrome|Chromium|Edg/.test(self.navigator.userAgent);

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'Claude Code', body: event.data && event.data.text() }; }
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Someone is looking at the app: the page shows its own toast for this,
    // so a system notification on top would be a duplicate.
    if (!MUST_SHOW && data.kind !== 'test' && windows.some((w) => w.focused)) return;
    await self.registration.showNotification(data.title || 'Claude Code', {
      body: data.body || '',
      tag: data.tag || undefined,
      renotify: !!data.tag,
      // A question blocks the session until answered: keep it on screen.
      requireInteraction: data.kind === 'attention',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { session: data.session || '' },
    });
  })());
});

// Tapping the alert opens the app on that session: an existing window if
// there is one (told which session via postMessage), else a new one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const session = (event.notification.data && event.notification.data.session) || '';
  const url = session ? `/?session=${encodeURIComponent(session)}` : '/';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = windows.find((w) => new URL(w.url).origin === self.location.origin);
    if (win) {
      await win.focus();
      if (session) win.postMessage({ type: 'open-session', session });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
