// Core notification dispatch logic. decideDispatch is pure so the dedupe window
// and presence-based "smart do-not-disturb" rules are unit-testable without any
// network. A device that is foregrounded AND looking at the very session that
// finished does NOT get a system push (it already sees the in-app hint).
import { join } from "node:path";
import { loadNotifyConfig, saveNotifyConfig, sanitizeNotifyConfig, type NotifyConfig } from "./notify-config";
import { ensureVapid, loadPushSubs, savePushSubs, upsertSub, removeSubsForDevice as rmSubs, sendPush, type PushSender, type PushSub } from "./web-push";
import { sendWebhook as defaultSendWebhook } from "./webhook-service";
import type { NotifyMsg } from "./webhook-templates";

export interface DevicePresence { pubKey: string; foreground: boolean; activeSessionId: string | null; }
export interface DispatchDecision { inApp: boolean; pushPubKeys: string[]; webhook: boolean; }

export function decideDispatch(args: {
  sessionId: string; lastTs: number | undefined; now: number; dedupeMs: number;
  presences: DevicePresence[];
}): DispatchDecision | null {
  if (args.lastTs !== undefined && args.now - args.lastTs < args.dedupeMs) return null;
  const pushPubKeys = args.presences
    .filter((p) => !(p.foreground && p.activeSessionId === args.sessionId))
    .map((p) => p.pubKey);
  return { inApp: true, pushPubKeys, webhook: true };
}

// Orchestrates the full dispatch fan-out (in-app broadcast + web push +
// webhooks) on top of the pure decideDispatch gate above. Config/subs/VAPID
// are loaded once at construction from <keyDir>; setConfig/addSub persist
// immediately (atomic write, see notify-config.ts / web-push.ts) so a crash
// right after a settings change never silently reverts it.
export class NotificationService {
  private cfgFile: string;
  private subsFile: string;
  private cfg: NotifyConfig;
  private subs: PushSub[];
  private vapid: { publicKey: string };
  private lastTs = new Map<string, number>();
  private deps: {
    keyDir: string;
    getPresences: () => DevicePresence[];
    broadcastInApp: (m: { sessionId: string; title: string; body: string; ts: number }) => void;
    pushSender: PushSender;
    webhookSend: typeof defaultSendWebhook;
    now: () => number;
  };

  constructor(deps: {
    keyDir: string;
    getPresences: () => DevicePresence[];
    broadcastInApp: (m: { sessionId: string; title: string; body: string; ts: number }) => void;
    pushSender: PushSender;
    webhookSend?: typeof defaultSendWebhook;
    now?: () => number;
  }) {
    this.deps = { now: () => Date.now(), webhookSend: defaultSendWebhook, ...deps };
    this.cfgFile = join(deps.keyDir, "notify.json");
    this.subsFile = join(deps.keyDir, "push-subs.json");
    this.cfg = loadNotifyConfig(this.cfgFile);
    this.subs = loadPushSubs(this.subsFile);
    this.vapid = ensureVapid(deps.keyDir);
  }

  config(): NotifyConfig { return this.cfg; }
  setConfig(c: NotifyConfig): void { this.cfg = sanitizeNotifyConfig(c); saveNotifyConfig(this.cfgFile, this.cfg); }
  vapidPublicKey(): string { return this.vapid.publicKey; }
  addSub(pubKey: string, subscription: unknown): void {
    this.subs = upsertSub(this.subs, { pubKey, subscription });
    savePushSubs(this.subsFile, this.subs);
  }
  removeSubsForDevice(pubKey: string): void {
    this.subs = rmSubs(this.subs, pubKey);
    savePushSubs(this.subsFile, this.subs);
  }

  async dispatch(p: { sessionId: string; title: string; body: string }): Promise<void> {
    const now = this.deps.now();
    const decision = decideDispatch({
      sessionId: p.sessionId,
      lastTs: this.lastTs.get(p.sessionId),
      now,
      dedupeMs: this.cfg.dedupeMs,
      presences: this.deps.getPresences(),
    });
    if (!decision) return;
    this.lastTs.set(p.sessionId, now);
    const body = this.cfg.includeSummary ? p.body : "";
    this.deps.broadcastInApp({ sessionId: p.sessionId, title: p.title, body, ts: now });
    const msg: NotifyMsg = {
      sessionId: p.sessionId, title: p.title, body,
      url: `/?session=${encodeURIComponent(p.sessionId)}`, status: "done", time: new Date(now).toISOString(),
    };
    if (this.cfg.webPush) {
      const skip = new Set(
        this.deps.getPresences()
          .filter((x) => x.foreground && x.activeSessionId === p.sessionId)
          .map((x) => x.pubKey),
      );
      const targets = this.subs.filter((s) => !skip.has(s.pubKey));
      const payload = JSON.stringify({ title: p.title, body, sessionId: p.sessionId });
      // 记下本轮的失败原因回报到 UI（发送失败原先完全静默）。规则：只要有一台
      // 设备发失败就留下原因，全部成功才清空——多设备时不能让一台成功盖掉另
      // 一台的失败。endpoint 已失效（410/404）不算失败：那是正常的订阅回收，
      // 该设备的订阅随即被删掉，报错反而是噪音。
      let lastErr: string | null = null;
      for (const t of targets) {
        const r = await sendPush(this.deps.pushSender, t, payload);
        if (r.gone) { this.removeSubsForDevice(t.pubKey); continue; }
        if (!r.ok && !lastErr) lastErr = r.error ?? "error";
      }
      if (targets.length && this.cfg.webPushLastError !== lastErr) {
        this.cfg.webPushLastError = lastErr;
        saveNotifyConfig(this.cfgFile, this.cfg);
      }
    }
    for (const wh of this.cfg.webhooks) {
      if (!wh.enabled) continue;
      const r = await this.deps.webhookSend(wh, msg, { now: this.deps.now });
      wh.lastError = r.ok ? null : (r.error ?? "error");
    }
    if (this.cfg.webhooks.length) saveNotifyConfig(this.cfgFile, this.cfg);
  }

  /**
   * 向单台设备发一条诊断推送（14 期需求 4）。
   *
   * 只回报"推送服务是否受理"（HTTP 层）。**是否真正送达要由前端回报**——
   * 生产实证：FCM 对已轮换的 endpoint 在宽限期内仍返回 201，
   * 只看状态码会得出"一切正常"的错误结论。前端据 payload 里的 diag 标记
   * 在 sw.js 里识别并 postMessage 回页面，超时未回报即判失败。
   *
   * 只发给发起请求的这台设备，不广播——测的是"我这台收不收得到"。
   */
  async testPushTo(pubKey: string): Promise<{ ok: boolean; error?: string }> {
    const sub = this.subs.find((s) => s.pubKey === pubKey);
    if (!sub) return { ok: false, error: "no_subscription" };
    const payload = JSON.stringify({
      title: "PocketShell",
      body: "诊断推送",
      diag: true,            // 前端据此识别并回报，见 public/sw.js
      tag: "ps-diag",
    });
    const r = await sendPush(this.deps.pushSender, sub, payload);
    if (r.gone) this.removeSubsForDevice(pubKey);
    return { ok: r.ok, error: r.error };
  }

  async testWebhook(id: string): Promise<{ ok: boolean; error?: string }> {
    const wh = this.cfg.webhooks.find((w) => w.id === id);
    if (!wh) return { ok: false, error: "not_found" };
    const now = this.deps.now();
    const msg: NotifyMsg = {
      sessionId: "test", title: "PocketShell", body: "测试通知 / test notification",
      url: "/", status: "test", time: new Date(now).toISOString(),
    };
    const r = await this.deps.webhookSend(wh, msg, { now: this.deps.now });
    wh.lastError = r.ok ? null : (r.error ?? "error");
    saveNotifyConfig(this.cfgFile, this.cfg);
    return r;
  }
}
