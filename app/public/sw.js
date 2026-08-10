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
//   everything else (incl. /preview/*, /sw.js)         -> bypass
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

  // 诊断推送（14 期需求 4）：回报给页面，证明链路真正打通。
  // **仍然要 showNotification** —— 部分浏览器要求每次 push 都显示通知，
  // 否则记一次"静默推送"违规，累计过多会吊销订阅权限。为了静默而冒
  // 吊销风险不划算，所以显示一条极简的、tag 固定因而不会堆积的通知。
  if (d.diag) {
    e.waitUntil((async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of all) c.postMessage({ type: "push-diag-received" });
      await self.registration.showNotification("PocketShell", {
        body: d.body || "诊断推送已送达", tag: "ps-diag",
      });
    })());
    return;
  }

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

// ---------------------------------------------------------------------------
// pushsubscriptionchange（14 期需求 4）
//
// W3C 规定：推送服务作废或轮换订阅时，浏览器在这里派发事件。这是重新订阅
// 并把新 endpoint 交给 agent 的**唯一标准时机**。此前没有这个处理，于是
// 轮换后浏览器持新 endpoint、agent 持旧的，双方都不知道——而 FCM 对已轮换
// 的旧 endpoint 在宽限期内仍返回 201，agent 侧连错误都看不到。
//
// SW 拿不到页面里的 Noise/WS 连接，也不能自己发 HTTP 给 agent（那要新增一条
// 无认证的公网路由，正是 VULN-001 的形状）。所以走两级降级：
//   一级：转发给活动页面，由它用已认证的 RPC 上报。
//   二级：没有活动页面时落 IndexedDB，页面下次启动连上时补报。
// ---------------------------------------------------------------------------

// 待补报的订阅。用 IndexedDB 而不是 Cache API——后者存的是 Response，
// 塞一个 JSON 进去要绕一圈；而 localStorage 在 SW 里根本不可用。
//
// 这三个名字与 src/lib/web-push-client.ts 的读取端逐字对应，漂移了就是
// "写进去永远没人读"且全程无报错。sw-cache.mirror.test.ts 钉住了这一点。
const PENDING_DB = "ps-push";
const PENDING_STORE = "pending";
const PENDING_KEY = "sub";

function openPendingDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(PENDING_DB, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(PENDING_STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function stashPendingSubscription(json) {
  try {
    const db = await openPendingDb();
    await new Promise((resolve, reject) => {
      // db.transaction / objectStore / put 都是**同步**返回的 IDB API，
      // 完成信号只在 tx 的 oncomplete 上——别在这里加 await。
      const tx = db.transaction(PENDING_STORE, "readwrite");
      tx.objectStore(PENDING_STORE).put(json, PENDING_KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* 存不下就算了，页面下次连上的无条件上报仍会对齐 */ }
}

self.addEventListener("pushsubscriptionchange", (e) => {
  e.waitUntil((async () => {
    // newSubscription 在部分浏览器上为空，那就自己用旧 key 重订一次
    let sub = e.newSubscription || null;
    if (!sub && e.oldSubscription) {
      try {
        sub = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: e.oldSubscription.options.applicationServerKey,
        });
      } catch { /* 拿不到就交给页面下次连上时的无条件上报兜底 */ }
    }
    if (!sub) return;
    const json = sub.toJSON();

    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (all.length > 0) {
      for (const c of all) c.postMessage({ type: "push-subscription-changed", subscription: json });
      return;
    }
    await stashPendingSubscription(json);
  })());
});
