// Service worker for installing the Web UI as an app. Deliberately caches
// nothing: the page is a live view of sessions on one machine, so an offline
// copy would only show stale state, and the server already marks index.html
// no-store so an upgrade is picked up on the next load. It exists because some
// browsers only offer "Install" to a page that has one, and it is the place web
// push will live.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
