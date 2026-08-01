// Notification config persisted at <keyDir>/notify.json. Atomic write (tmp+
// rename), mode 0600 — it holds webhook URLs/secrets (sensitive). Mirrors the
// persist pattern in device-registry.ts.
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

export type WebhookKind = "wecom" | "feishu" | "slack" | "discord" | "custom";
export interface WebhookCfg {
  id: string; name: string; kind: WebhookKind; url: string;
  enabled: boolean; secret?: string; template?: string;
  method?: string; headers?: Record<string, string>; lastError?: string | null;
}
export interface NotifyConfig {
  tools: { claude: boolean; codex: boolean; opencode: boolean; kimi: boolean };
  webPush: boolean; includeSummary: boolean; dedupeMs: number; webhooks: WebhookCfg[];
  /** 上次 Web Push 发送失败的原因（成功即清空）。与 WebhookCfg.lastError 同
   *  样的用途：发送失败原先完全静默，用户只看到开关是「开」却收不到推送。
   *  最常见的失败是这台服务器连不上 fcm.googleapis.com。 */
  webPushLastError?: string | null;
  /** 需求 5：接管 Claude Code 的 statusLine 以获取上下文用量。与 tools.* 不同
   *  ——它不产生任何通知，只取数字，所以单列一个字段而不是塞进 tools。 */
  contextStatusline: boolean;
}

export function defaultNotifyConfig(): NotifyConfig {
  return { tools: { claude: false, codex: false, opencode: false, kimi: false }, webPush: false, webPushLastError: null, includeSummary: true, dedupeMs: 10000, webhooks: [], contextStatusline: false };
}

// Validates/coerces an arbitrary parsed value (disk JSON or a client RPC
// payload) into a well-formed NotifyConfig. Shared by loadNotifyConfig (disk)
// and NotificationService.setConfig (client input) so malformed input never
// corrupts persisted state — e.g. dedupeMs: NaN/Infinity, or webhooks sent as
// a non-array, silently fall back to safe defaults instead of propagating.
export function sanitizeNotifyConfig(raw: unknown): NotifyConfig {
  const j = raw as Record<string, unknown> | null | undefined;
  const d = defaultNotifyConfig();
  const tools = j?.tools as Record<string, unknown> | undefined;
  const dedupeMs = typeof j?.dedupeMs === "number" && Number.isFinite(j.dedupeMs) ? j.dedupeMs : d.dedupeMs;
  return {
    tools: { claude: !!tools?.claude, codex: !!tools?.codex, opencode: !!tools?.opencode, kimi: !!tools?.kimi },
    webPush: !!j?.webPush,
    webPushLastError: typeof j?.webPushLastError === "string" ? j.webPushLastError : null,
    includeSummary: j?.includeSummary !== false,
    dedupeMs,
    webhooks: Array.isArray(j?.webhooks) ? (j.webhooks as WebhookCfg[]) : [],
    contextStatusline: !!j?.contextStatusline,
  };
}

export function loadNotifyConfig(file: string): NotifyConfig {
  if (!existsSync(file)) return defaultNotifyConfig();
  try {
    return sanitizeNotifyConfig(JSON.parse(readFileSync(file, "utf8")));
  } catch { return defaultNotifyConfig(); }
}

export function saveNotifyConfig(file: string, cfg: NotifyConfig): void {
  const tmp = join(dirname(file), `.notify.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}
