// Web Push via VAPID (self-hosted, no third-party account). VAPID keypair is
// generated once into <keyDir>/vapid.json (0600). Subscriptions are keyed by
// device Noise pubkey so a revoked device's subs are dropped. sendPush injects
// the actual sender (web-push lib) so the send logic is unit-testable; a 410/404
// means the subscription is dead and should be pruned.
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import webpush from "web-push";

export interface PushSub { pubKey: string; subscription: unknown; }
export interface VapidKeys { publicKey: string; privateKey: string; }

export function ensureVapid(keyDir: string): VapidKeys {
  const file = join(keyDir, "vapid.json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const k = webpush.generateVAPIDKeys();
  const out: VapidKeys = { publicKey: k.publicKey, privateKey: k.privateKey };
  writeFileSync(file, JSON.stringify(out), { mode: 0o600 });
  return out;
}

export function loadPushSubs(file: string): PushSub[] {
  if (!existsSync(file)) return [];
  try { const j = JSON.parse(readFileSync(file, "utf8")); return Array.isArray(j?.subs) ? j.subs : []; }
  catch { return []; }
}
export function savePushSubs(file: string, subs: PushSub[]): void {
  const tmp = join(dirname(file), `.push-subs.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify({ v: 1, subs }), { mode: 0o600 });
  renameSync(tmp, file);
}
export function upsertSub(subs: PushSub[], sub: PushSub): PushSub[] {
  const rest = subs.filter((s) => s.pubKey !== sub.pubKey);
  return [...rest, sub];
}
export function removeSubsForDevice(subs: PushSub[], pubKey: string): PushSub[] {
  return subs.filter((s) => s.pubKey !== pubKey);
}

export type PushSender = (subscription: unknown, payload: string) => Promise<{ statusCode: number }>;
export async function sendPush(sender: PushSender, sub: PushSub, payload: string): Promise<{ ok: boolean; gone: boolean }> {
  try { const r = await sender(sub.subscription, payload); const ok = r.statusCode >= 200 && r.statusCode < 300; return { ok, gone: false }; }
  catch (e) { const code = (e as { statusCode?: number }).statusCode; return { ok: false, gone: code === 404 || code === 410 }; }
}

// Real sender factory (not unit-tested; exercised in end-to-end). VAPID subject
// must be a mailto: or https: URL per spec.
export function realPushSender(vapid: VapidKeys): PushSender {
  return (subscription, payload) =>
    webpush.sendNotification(subscription as webpush.PushSubscription, payload, {
      vapidDetails: { subject: "https://github.com/Big-Pony/pocketshell", publicKey: vapid.publicKey, privateKey: vapid.privateKey },
    }).then((r) => ({ statusCode: r.statusCode }));
}
