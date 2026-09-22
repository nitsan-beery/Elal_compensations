// Service worker: האפליקציה עובדת גם בלי רשת.
//
// רשת קודם (בלי מטמון ה-HTTP של הדפדפן), ואם אין רשת – מהמטמון. כך עדכון בקוד או ב-rules.json מגיע מיד כשיש חיבור,
// ובלי חיבור האפליקציה נפתחת מהעותק האחרון. בכל עדכון של רשימת הקבצים מעלים את CACHE.

const CACHE = 'elal-compensations-v5';
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'rules.json',
  'css/app.css',
  'js/app.js',
  'js/store.js',
  'js/model.js',
  'js/time.js',
  'js/airports.js',
  'js/pdf/extract.js',
  'js/pdf/plan.js',
  'js/pdf/exec.js',
  'js/rules/catalog.js',
  'js/rules/evaluate.js',
  'js/rules/logic.js',
  'js/rules/duty.js',
  'vendor/pdfjs/pdf.mjs',
  'vendor/pdfjs/pdf.worker.mjs',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// רק קבצי האפליקציה נשמרים במטמון. שום קובץ אחר מאותו מקור לא נשמר.
const SHELL_URLS = new Set(SHELL.map((p) => new URL(p, self.location).href));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  url.search = '';
  if (req.method !== 'GET' || !SHELL_URLS.has(url.href)) return;
  // GitHub Pages שולח max-age=600, כך שבלי no-cache הדפדפן מגיש עותק ישן עד עשר דקות אחרי
  // עדכון. no-cache שואל את השרת בכל טעינה (ETag), ומקבל 304 קצר כשלא השתנה דבר.
  event.respondWith(
    fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit ?? (req.mode === 'navigate' ? caches.match('index.html') : Response.error()))),
  );
});
