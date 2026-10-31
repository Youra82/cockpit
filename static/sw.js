'use strict';
// Service-Worker nur fuer Mitteilungen (kein Offline-Cache: die App zeigt immer den aktuellen Stand vom Server).

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: 'Bot-Cockpit', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Bot-Cockpit', {
    body: d.body || '', tag: d.tag || undefined, data: { url: d.url || '#/' }, icon: 'icon-180.png', badge: 'icon-180.png',
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL('/' + String(e.notification.data && e.notification.data.url || '#/').replace(/^\/+/, ''), self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if ('focus' in c) { c.navigate ? c.navigate(target) : null; return c.focus(); }
    }
    return self.clients.openWindow(target);
  }));
});
