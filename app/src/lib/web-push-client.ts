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
