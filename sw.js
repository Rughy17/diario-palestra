// Service worker: rende l'app utilizzabile anche senza connessione.
// Quando modifichi i file dell'app, aumenta il numero di versione qui sotto.
const VERSION = 'diario-palestra-v1';
const SHELL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'config.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js',
];
const CDN_HOSTS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// File dell'app: prima la rete (per avere gli aggiornamenti), con ripiego sulla copia salvata
// se la rete è assente o lenta (oltre 2,5 secondi).
async function networkFirst(event) {
  const req = event.request;
  const cache = await caches.open(VERSION);
  const net = fetch(req).then(res => {
    if (res.ok) cache.put(req.mode === 'navigate' ? './' : req, res.clone());
    return res;
  });
  event.waitUntil(net.then(() => {}, () => {}));
  const cached = (await cache.match(req, { ignoreSearch: true })) ||
    (req.mode === 'navigate' ? await cache.match('./') : undefined);
  if (!cached) return net;
  return Promise.race([
    net.catch(() => cached),
    new Promise(resolve => setTimeout(() => resolve(cached), 2500)),
  ]);
}

// Librerie e font: prima la copia salvata.
async function cacheFirst(req) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(event));
  } else if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(req));
  }
  // Le richieste a Supabase passano direttamente alla rete.
});
