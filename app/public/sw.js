// Minimal network-only service worker — exists only to satisfy PWA
// installability. No caching on purpose: PocketShell is a live terminal
// (WebSocket), offline is useless, and caching could serve a stale shell.
// skipWaiting + clients.claim keep updates immediate.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {}); // pass-through: browser falls back to network

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
