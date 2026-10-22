// Web Push handlers, imported into the generated service worker (vite.config.ts workbox.importScripts).
// The server sends JSON {title, body, url, tag} (apps/api/internal/notifications/push.go).
// Resolves a payload path against this origin; anything pointing elsewhere falls back to /notifications.
const sameOrigin = (path) => {
  try {
    const u = new URL(typeof path === 'string' ? path : '/notifications', self.location.origin);
    if (u.origin === self.location.origin) return u.href;
  } catch {}
  return new URL('/notifications', self.location.origin).href;
};

self.addEventListener('push', (event) => {
  let msg = {};
  try {
    msg = event.data ? event.data.json() : {};
  } catch {
    msg = { body: event.data ? event.data.text() : '' };
  }
  const url = sameOrigin(msg.url);
  event.waitUntil(
    self.registration.showNotification(msg.title || 'Finance Platform', {
      body: msg.body || '',
      tag: msg.tag || undefined,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = sameOrigin(event.notification.data?.url);
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (new URL(w.url).origin === self.location.origin && 'focus' in w) {
          return w.focus().then((c) => (c && 'navigate' in c ? c.navigate(target) : c));
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
