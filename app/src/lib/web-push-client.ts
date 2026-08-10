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
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    // Uint8Array<ArrayBufferLike> vs BufferSource: lib.dom 的 PushSubscription-
    // OptionsInit 只认 ArrayBuffer 支撑的视图，而 TS 5.7 起 Uint8Array 带上了
    // 缓冲区类型参数。运行时是同一个 Uint8Array，取 .buffer 让签名对上。
    applicationServerKey: urlBase64ToUint8Array(publicKey).buffer as ArrayBuffer,
  });
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
