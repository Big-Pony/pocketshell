// app/src/lib/cache-admin.ts
// Browser-side cache/service-worker teardown. Kept apart from lib/sw-cache.ts
// (pure rules, unit-tested) because everything here touches real browser APIs.
import { BUCKET_PREFIX } from "./sw-cache";

/** Delete every cache bucket this app owns. Buckets owned by others survive. */
export async function clearAppCaches(): Promise<void> {
  if (!("caches" in globalThis)) return;
  const keys = await caches.keys();
  await Promise.all(keys.filter((k) => k.startsWith(BUCKET_PREFIX)).map((k) => caches.delete(k)));
}

/**
 * 触发所有 Service Worker 走标准 update 流程。
 *
 * **刻意不用 unregister()**（14 期需求 4）：按 Push API 规范，push 订阅是
 * SW 注册的子对象，注销必然销毁订阅——这正是"每次版本更新后推送就失效"的
 * 自伤来源，而 web.dev 的 PWA 更新指南明文建议不要用注销来强制更新。
 *
 * 另外 unregister() 的返回值本就不可信（找不到注册返回 false，否则一律 true，
 * 不管实际是否注销成功），而且注销后订阅失效**不是瞬时的**（SW 仍被现存页面
 * 使用），这让"注销完立刻查 getSubscription()"拿到一个将死未死的订阅——
 * 之前那版自愈"修了没用"的时序根因就在这里。
 *
 * 版本一致性由别处保证：SW 注册 URL 带 `?v=<version>`，同 scope 换 scriptURL
 * 浏览器就走 registration update；缓存桶名 `ps-v<version>` 版本一变整桶丢弃。
 * 注销从来不是保证同版本的必要手段。
 */
export async function updateServiceWorkers(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  const regs = await navigator.serviceWorker.getRegistrations();
  await Promise.all(regs.map((r) => r.update()));
}

/**
 * Full teardown: drop caches, refresh workers, then reload. Used both after an
 * OTA version bump and by the manual "clear cache" button in Settings.
 * Best-effort — a failure here must never leave the user stuck, so we reload
 * regardless.
 */
export async function hardReset(): Promise<void> {
  try {
    await clearAppCaches();
    await updateServiceWorkers();
  } catch {
    /* best-effort: reload anyway */
  }
  location.reload();
}
