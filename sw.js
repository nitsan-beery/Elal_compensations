// מחליף את ה-service worker של האפליקציה הקודמת בנתיב הזה: מוחק את העותק השמור שלה ואת עצמו,
// כדי שגם בלי רשת לא תיפתח הגרסה הקודמת. רק מטמון שכל הקבצים בו מהנתיב הזה, ולא של אתרים אחרים בדומיין.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const scope = self.registration.scope;
    for (const key of await caches.keys()) {
      const c = await caches.open(key);
      const reqs = await c.keys();
      if (reqs.length && reqs.every((q) => q.url.startsWith(scope))) await caches.delete(key);
    }
    await self.registration.unregister();
    for (const client of await self.clients.matchAll({ type: 'window' })) client.navigate(client.url);
  })());
});
