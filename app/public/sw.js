// Minimal network-only service worker — exists only to satisfy PWA
// installability. No caching on purpose: PocketShell is a live terminal
// (WebSocket), offline is useless, and caching could serve a stale shell.
// skipWaiting + clients.claim keep updates immediate.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {}); // pass-through: browser falls back to network
