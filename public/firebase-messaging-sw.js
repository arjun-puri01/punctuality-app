// Minimal push notification service worker — no external dependencies.
// Firebase's getToken() only needs a registered SW; it doesn't care what's in it.
// Background messages are handled here via the standard Web Push API.

self.addEventListener('push', event => {
  if (!event.data) return;

  let payload;
  try { payload = event.data.json(); } catch { payload = {}; }

  const title = payload.notification?.title || 'Clocked';
  const body  = payload.notification?.body  || '';

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon:  '/favicon.ico',
      badge: '/favicon.ico',
      tag:   'punctuality',
      data:  { url: payload.data?.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});
