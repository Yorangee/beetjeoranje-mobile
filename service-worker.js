// Verhoog dit versienummer bij elke deploy — dat forceert een verse cache
// en triggert de "nieuwe versie beschikbaar" melding in de app.
const CACHE_NAME = 'beetjeoranje-mobile-v24';
const CORE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './auth.js',
  './data.js',
  './manifest.json',
  './icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Network-first voor de app-shell (html/js/css), zodat updates zo snel mogelijk
// doorkomen zodra je online bent. API-aanroepen (Google/Todoist) gaan altijd
// gewoon rechtstreeks het netwerk op, die worden niet gecachet.
self.addEventListener('fetch', (event) => {
  const url = event.request.url;
  // API-aanroepen én externe CDN-libraries (Chart.js, pdf.js — alleen geladen wanneer
  // nodig) altijd gewoon rechtstreeks het netwerk op, nooit onderscheppen/cachen hier.
  const isApiCall = url.includes('googleapis.com') || url.includes('api.todoist.com') || url.includes('accounts.google.com')
    || url.includes('cdn.jsdelivr.net') || url.includes('cdnjs.cloudflare.com');
  if (isApiCall) return;

  const isAppShell = event.request.mode === 'navigate' || /\.(js|css|json|svg)$/.test(url);
  if (!isAppShell) return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});

// Laat de pagina de nieuwe service worker meteen activeren zodra die daarom vraagt
// (aangeroepen vanuit app.js na het tonen van de "nieuwe versie"-melding).
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
