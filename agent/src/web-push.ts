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
  if (existsSync(file)) {
    try { return JSON.parse(readFileSync(file, "utf8")); }
    catch { /* corrupt -> regenerate below */ }
  }
  const k = webpush.generateVAPIDKeys();
  const out: VapidKeys = { publicKey: k.publicKey, privateKey: k.privateKey };
  const tmp = join(dirname(file), `.vapid.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 });
  renameSync(tmp, file);
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
// error 带出失败原因（成功时不设）。原先只回 ok/gone 两个 bool，发送失败的
// 原因被整个吞掉——用户在设置面板看到 Web Push 开着却收不到推送，无从知道
// 是这台服务器发不出去（最常见：连不上 fcm.googleapis.com）。现在像 webhook
// 的 lastError 一样把原因带到 UI。
export async function sendPush(
  sender: PushSender, sub: PushSub, payload: string,
): Promise<{ ok: boolean; gone: boolean; error?: string }> {
  try {
    const r = await sender(sub.subscription, payload);
    const ok = r.statusCode >= 200 && r.statusCode < 300;
    return ok ? { ok, gone: false } : { ok, gone: false, error: `status ${r.statusCode}` };
  } catch (e) {
    const err = e as { statusCode?: number; body?: unknown; message?: string };
    const code = err.statusCode;
    // web-push 把所有 HTTP 层失败统一抛成 "Received unexpected response code"，
    // 诊断信息全在 statusCode/body 上（实证：VAPID 不匹配时 body 才写着
    // "the VAPID credentials ... do not correspond"）。只取 message 会把这些
    // 丢光，UI 上只剩一句什么也没说的通用文本。
    const body = typeof err.body === "string" ? err.body.trim() : "";
    // 404/410 = 推送服务说这个 endpoint 没了（正常回收）。
    // 403 = VAPID 凭据对不上（换服务器或重生成密钥后旧订阅必得此码，
    //       body 明说 "the VAPID credentials ... do not correspond"）。
    //       此前不算 gone，坏订阅会永久卡住：每次发都失败、每次都不清理，
    //       而浏览器侧那条用旧 key 建的订阅也还在，自愈同样救不了。
    //       当成 gone 删掉即可——下次连接时前端会用新 key 重建（14 期）。
    const gone = code === 404 || code === 410 || code === 403;
    if (code) return { ok: false, gone, error: body ? `status ${code}: ${body}` : `status ${code}` };
    return { ok: false, gone: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Real sender factory (not unit-tested; exercised in end-to-end). VAPID subject
// must be a mailto: or https: URL per spec.
export function realPushSender(vapid: VapidKeys): PushSender {
  return (subscription, payload) =>
    webpush.sendNotification(subscription as webpush.PushSubscription, payload, {
      vapidDetails: { subject: "https://github.com/Big-Pony/pocketshell", publicKey: vapid.publicKey, privateKey: vapid.privateKey },
    }).then((r) => ({ statusCode: r.statusCode }));
}
