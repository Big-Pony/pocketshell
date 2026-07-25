// Versioned-bucket caching service worker.
//
// Design doc: docs/superpowers/specs/2026-07-25-pwa缓存优化-design.md
//
// This file is copied verbatim by vite (no bundling, no imports), so the rules
// below are a HAND-MIRRORED COPY of app/src/lib/sw-cache.ts, which is the
// unit-tested source of truth. CHANGE ONE, CHANGE BOTH. (Same arrangement as
// index.html's inline theme guard <-> lib/theme.ts.)
//
// Strategy, by path:
//   /assets/*, /fonts/*, /icons/*, /manifest.webmanifest -> cache-first
//   /, /index.html                                       -> network-first
//   everything else (incl. /preview/*, /admin*, /sw.js)  -> bypass
// Allowlist by design: an unlisted path is never cached, so a future
// token-authed route can't be cached by accident.
//
// Cache bucket is named ps-v<version>, where <version> comes from this
// worker's own registration URL (?v=… set in src/main.ts). A release changes
// that URL, so the browser installs a fresh worker, which builds a new bucket
// and drops every older ps-v* one.

const VERSION = new URL(self.location.href).searchParams.get("v") || "0.0.0";
const BUCKET_PREFIX = "ps-v";
const BUCKET = BUCKET_PREFIX + VERSION;

const CACHE_FIRST_PREFIXES = ["/assets/", "/fonts/", "/icons/"];
const CACHE_FIRST_EXACT = ["/manifest.webmanifest"];
const NETWORK_FIRST_EXACT = ["/", "/index.html"];

function cacheStrategy(pathname) {
  if (NETWORK_FIRST_EXACT.indexOf(pathname) !== -1) return "network-first";
  if (CACHE_FIRST_EXACT.indexOf(pathname) !== -1) return "cache-first";
  for (const p of CACHE_FIRST_PREFIXES) if (pathname.startsWith(p)) return "cache-first";
  return "bypass";
}

// Nothing is precached: the bucket fills lazily as the app requests things.
// That keeps install cheap and avoids shipping a build manifest into this file.
self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) =>
  e.waitUntil(
    (async () => {
      // Drop every bucket we own except the current version's. Buckets owned by
      // anything else are left alone (prefix check).
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith(BUCKET_PREFIX) && k !== BUCKET)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  ),
);

async function cacheFirst(req) {
  const cache = await caches.open(BUCKET);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  // Only store complete, successful responses — a 404/opaque/206 in the bucket
  // would be served back forever.
  if (res && res.status === 200 && res.type === "basic") cache.put(req, res.clone());
  return res;
}

async function networkFirst(req) {
  const cache = await caches.open(BUCKET);
  try {
    const res = await fetch(req);
    if (res && res.status === 200 && res.type === "basic") cache.put(req, res.clone());
    return res;
  } catch (err) {
    // Agent unreachable: fall back to the last good shell rather than a
    // browser error page. Offline is still not supported (the terminal needs
    // the WebSocket) — this only avoids a blank screen.
    const hit = await cache.match(req);
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return; // let the browser handle it
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // third-party: never our business
  const strategy = cacheStrategy(url.pathname);
  if (strategy === "cache-first") e.respondWith(cacheFirst(req));
  else if (strategy === "network-first") e.respondWith(networkFirst(req));
  // bypass: don't call respondWith at all — the browser does its normal thing
});

// Push notifications (Task: notifications). Payload JSON: {title, body, sessionId}.
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = {}; }
  const title = d.title || "PocketShell";
  const body = d.body || "";
  const sessionId = d.sessionId || "";
  e.waitUntil(self.registration.showNotification(title, {
    body, tag: sessionId || "pocketshell", data: { url: "/?session=" + encodeURIComponent(sessionId) },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) { if ("focus" in c) { await c.focus(); c.postMessage({ type: "notification-nav", url }); return; } }
    if (self.clients.openWindow) await self.clients.openWindow(url);
  })());
});
