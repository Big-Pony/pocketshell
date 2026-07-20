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
  tools: { claude: boolean; codex: boolean; opencode: boolean };
  webPush: boolean; includeSummary: boolean; dedupeMs: number; webhooks: WebhookCfg[];
}

export function defaultNotifyConfig(): NotifyConfig {
  return { tools: { claude: false, codex: false, opencode: false }, webPush: false, includeSummary: true, dedupeMs: 10000, webhooks: [] };
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
    tools: { claude: !!tools?.claude, codex: !!tools?.codex, opencode: !!tools?.opencode },
    webPush: !!j?.webPush,
    includeSummary: j?.includeSummary !== false,
    dedupeMs,
    webhooks: Array.isArray(j?.webhooks) ? (j.webhooks as WebhookCfg[]) : [],
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
