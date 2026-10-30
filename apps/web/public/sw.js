/* MediCare service worker.
 * - Precaches the app shell and the /emergency page (with its JS/CSS) so emergency help opens offline.
 * - Never caches API calls (/n8n/*): health data is always fetched live.
 * - The cache version comes from the worker's own address (/sw.js?v=<build id>): each deploy registers a new
 *   worker, which deletes the caches of older builds when it activates.
 */
const VERSION = (() => {
  try {
    return new URL(self.location.href).searchParams.get('v') || 'v1';
  } catch {
    return 'v1';
  }
})().replace(/[^A-Za-z0-9._-]/g, '');
const SHELL = `dc-shell-${VERSION}`;
const RUNTIME = `dc-runtime-${VERSION}`;
const PRECACHE = ['/emergency', '/login', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png'];

async function precache() {
  const cache = await caches.open(SHELL);
  await Promise.all(
    PRECACHE.map(async (url) => {
      try {
        const res = await fetch(url, { cache: 'reload' });
        if (!res.ok) return;
        await cache.put(url, res.clone());
        if (res.headers.get('content-type')?.includes('text/html')) {
          // cache every static asset the page needs to boot
          const html = await res.text();
          const assets = new Set(Array.from(html.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+)"/g), (m) => m[1]));
          await Promise.all(
            [...assets].map(async (a) => {
              try {
                const r = await fetch(a);
                if (r.ok) await cache.put(a, r);
              } catch {
                /* best effort */
              }
            }),
          );
        }
      } catch {
        /* offline during install: try again next time */
      }
    }),
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  // remove every cache of this app from older builds (and anything else not in use)
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== RUNTIME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Web push from the platform (workflows/src/push.mjs): a generic title and body and the page to open. Details stay in
// the app, so nothing about the person's health passes through the browser's push service.
self.addEventListener('push', (event) => {
  let m = {};
  try { m = event.data ? event.data.json() : {}; } catch { m = {}; }
  const url = typeof m.url === 'string' && m.url.startsWith('/') ? m.url : '/app/today';
  event.waitUntil(
    self.registration.showNotification(m.title || 'Update', {
      body: m.body || '',
      tag: m.tag || 'update',
      renotify: m.tag === 'urgent',
      requireInteraction: m.tag === 'urgent',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url },
    }),
  );
});

// Tapping a notification (a push, or the local "measure again" reminder) opens or focuses the app on its page.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/app/today';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => new URL(c.url).origin === self.location.origin);
      if (open) return open.focus().then((c) => (c && 'navigate' in c ? c.navigate(target) : c));
      return self.clients.openWindow(target);
    }),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/n8n/')) return; // live data only

  // Immutable build assets: cache first.
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(RUNTIME).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  // Page navigations: network first, then the cached page, then the offline-safe emergency page.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(RUNTIME).then((c) => c.put(url.pathname, copy));
          }
          return res;
        })
        .catch(async () => (await caches.match(url.pathname)) || (await caches.match('/emergency')) || Response.error()),
    );
    return;
  }

  // React Server Component payloads for client-side navigation: network only (the router falls back to a full load).
  if (url.searchParams.has('_rsc')) return;

  // Other same-origin files (icons, fonts, manifest): stale while revalidate.
  event.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(RUNTIME).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || net;
    }),
  );
});
