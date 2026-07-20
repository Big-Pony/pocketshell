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
      for (const t of targets) {
        const r = await sendPush(this.deps.pushSender, t, payload);
        if (r.gone) this.removeSubsForDevice(t.pubKey);
      }
    }
    for (const wh of this.cfg.webhooks) {
      if (!wh.enabled) continue;
      const r = await this.deps.webhookSend(wh, msg, { now: this.deps.now });
      wh.lastError = r.ok ? null : (r.error ?? "error");
    }
    if (this.cfg.webhooks.length) saveNotifyConfig(this.cfgFile, this.cfg);
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
