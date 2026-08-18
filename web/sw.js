/*
 * CodeRelay service worker.
 *
 * Caches ONLY the public application shell. The API is never touched: task
 * data, diffs, git information and the session all stay strictly network-only,
 * so nothing sensitive can ever be served from (or poisoned into) a cache.
 * Live updates are SSE, which a service worker must never buffer.
 */
'use strict';

// Bump on shell changes: activate deletes older caches, forcing a refetch.
const CACHE_NAME = 'coderelay-shell-v3';

const SHELL = [
  '/',
  '/style.css',
  '/app.js',
  '/favicon.svg',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

// The page shows an update note and calls this when the operator opts in.
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never intercept anything that is not a same-origin GET, and never the API:
  // auth, tasks, diffs and the SSE stream must always hit the network.
  if (event.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // App shell: cache-first with background refresh, so launches are instant
  // and a deploy is picked up on the next load.
  event.respondWith(
    caches.match(event.request.mode === 'navigate' ? '/' : event.request).then((cached) => {
      const fetched = fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request.mode === 'navigate' ? '/' : event.request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached ?? fetched;
    }),
  );
});
