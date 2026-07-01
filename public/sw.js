// Offline cache with sensible update behaviour:
//  - HTML navigations AND the AudioWorklet are network-first, so a new deploy shows
//    up on the next online reload (falling back to cache when offline). The worklet
//    (worklet/engine.js) has a FIXED, non-hashed filename, so it must NOT be
//    cache-first — otherwise a stale engine keeps running after the app updates and
//    the new message protocol silently breaks audio.
//  - Hashed assets are cache-first (their content-hash filename makes them
//    immutable, so a cache hit is always correct).
// Bump CACHE to force clients off old caches.

const CACHE = "msq010-v5";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;

  const isNavigation = req.mode === "navigate" || req.destination === "document";
  // The AudioWorklet has a fixed (non-hashed) filename, so serve it network-first too.
  const isWorklet = new URL(req.url).pathname.includes("/worklet/");

  if (isNavigation || isWorklet) {
    // Network-first: always try for the freshest HTML / engine when online.
    e.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        try {
          const res = await fetch(req);
          cache.put(req, res.clone());
          return res;
        } catch {
          return (await cache.match(req)) || (isNavigation ? await cache.match("./index.html") : null) || Response.error();
        }
      })()
    );
    return;
  }

  // Cache-first for hashed/static assets.
  e.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req);
      if (cached) return cached;
      const res = await fetch(req);
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    })()
  );
});
