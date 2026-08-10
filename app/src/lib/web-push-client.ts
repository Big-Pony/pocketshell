// app/src/lib/web-push-client.ts
// Browser-side Web Push subscription plumbing. Split out of SettingsPanel so
// the settings toggle and App.svelte's startup self-heal run the exact same
// subscribe path — two copies would drift, and a drift here is invisible
// (push silently stops working; nothing throws).
//
// The decision of WHETHER to resubscribe lives in lib/notify.ts
// (needsResubscribe, unit-tested); this file is the thin layer that actually
// touches navigator/PushManager and is therefore not unit-tested.
import { urlBase64ToUint8Array } from "./notify";

interface PushConn {
  notifyGetVapidKey(): Promise<{ publicKey: string }>;
  notifySubscribe(subscription: unknown): Promise<unknown>;
}

/** True when this browser currently holds a push subscription. */
export async function hasBrowserSubscription(): Promise<boolean> {
  if (!("serviceWorker" in navigator)) return false;
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return false; // SW gone (e.g. after hardReset) => subscription gone with it
  return (await reg.pushManager.getSubscription()) !== null;
}

/**
 * Subscribe this browser to push and report the subscription to the agent.
 * Throws on failure — callers decide whether that surfaces to the user
 * (settings toggle: yes) or stays silent (startup self-heal: no).
 *
 * Callers must ensure notification permission is already "granted": subscribe()
 * shows the permission prompt itself when permission is still "default", which
 * would mean a prompt out of nowhere on the startup path. The settings toggle
 * calls requestPermission() first; the self-heal path gates on
 * needsResubscribe(), which requires "granted".
 */
export async function subscribeAndReport(conn: PushConn): Promise<void> {
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await conn.notifyGetVapidKey();
  // Uint8Array<ArrayBufferLike> vs BufferSource: lib.dom 的 PushSubscription-
  // OptionsInit 只认 ArrayBuffer 支撑的视图，而 TS 5.7 起 Uint8Array 带上了
  // 缓冲区类型参数。运行时是同一个 Uint8Array，取 .buffer 让签名对上。
  const opts: PushSubscriptionOptionsInit = {
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey).buffer as ArrayBuffer,
  };
  let sub: PushSubscription;
  try {
    sub = await reg.pushManager.subscribe(opts);
  } catch (e) {
    // InvalidStateError = 已存在一个用**不同 applicationServerKey** 建的订阅
    // （换服务器或 agent 重生成 VAPID 后必然如此）。规范要求先退订再重订，
    // 这是 VAPID 换掉后唯一的自动恢复路径——用户"手动关一次再开就好"正是
    // 因为关的时候走了 unsubscribeBrowser()。
    if ((e as Error)?.name !== "InvalidStateError") throw e;
    const stale = await reg.pushManager.getSubscription();
    if (stale) await stale.unsubscribe();
    sub = await reg.pushManager.subscribe(opts);
  }
  await conn.notifySubscribe(sub.toJSON());
}

/**
 * Drop this browser's push subscription, if any. Returns true when something
 * was actually unsubscribed.
 *
 * Turning push off used to only tell the agent to stop sending, leaving a live
 * subscription behind in the browser — the push service still held an endpoint
 * nobody would ever use again. Best-effort by design: the agent has already
 * stopped sending by the time this runs, so a failure here is untidy, not
 * harmful, and must not block the toggle from going off.
 */
export async function unsubscribeBrowser(): Promise<boolean> {
  if (!("serviceWorker" in navigator)) return false;
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return false;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return false;
  return await sub.unsubscribe();
}

/**
 * 把本设备当前的推送订阅上报给 agent（14 期需求 4 的核心）。
 *
 * 与 subscribeAndReport 的差别：**有订阅就直接上报那一条，不重新订阅**。
 * 重新订阅会换掉 endpoint，让本来还能用的订阅失效——我们要的是"对齐"
 * 而不是"重建"。只有确实没有订阅时才新建。
 *
 * 调用方需先用 shouldSyncPush() 确认前提（权限已授予 + agent 侧开着）。
 */
export async function syncSubscription(conn: PushConn): Promise<"synced" | "subscribed" | "skipped"> {
  if (!("serviceWorker" in navigator)) return "skipped";
  // 先清掉 SW 在无活动页面时存下的待补报订阅（14 期需求 4 的二级降级）。
  // 读完即删——补报失败也不重试，因为紧接着的无条件上报会覆盖它。
  await flushPendingSubscription(conn);
  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  if (existing) {
    // 原样上报。agent 按设备公钥 upsert，重复上报无害；而这一次上报正是
    // 修好"agent 手里是过期 endpoint"的那一步。
    await conn.notifySubscribe(existing.toJSON());
    return "synced";
  }
  await subscribeAndReport(conn);
  return "subscribed";
}

/**
 * 取出并清除 SW 存下的待补报订阅（pushsubscriptionchange 的二级降级）。
 *
 * 库/表/键名与 `public/sw.js` 的写入端逐字对应（PENDING_DB / PENDING_STORE /
 * PENDING_KEY）；sw-cache.mirror.test.ts 钉住了这三对名字不漂移——那边无构建
 * 无类型检查，名字对不上会静默地"写进去永远没人读"。
 */
async function flushPendingSubscription(conn: PushConn): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("ps-push", 1);
      req.onupgradeneeded = () => { req.result.createObjectStore("pending"); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const json = await new Promise<unknown>((resolve) => {
      const tx = db.transaction("pending", "readwrite");
      const store = tx.objectStore("pending");
      const get = store.get("sub");
      get.onsuccess = () => { store.delete("sub"); resolve(get.result ?? null); };
      get.onerror = () => resolve(null);
    });
    if (json) await conn.notifySubscribe(json);
  } catch { /* 补报是尽力而为；紧接着的无条件上报才是主路径 */ }
}
