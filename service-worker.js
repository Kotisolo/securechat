self.addEventListener('push', event => {
  let data = { title: 'SecureChat', body: 'New encrypted message', url: '/app.html' };
  try { data = Object.assign(data, event.data.json()); } catch {}
  event.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || 'securechat',
    data: { url: data.url || '/app.html' }
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/app.html';
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const client of list) if (client.url.includes('/app.html')) return client.focus();
    return clients.openWindow(url);
  }));
});
