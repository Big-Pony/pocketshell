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

export function loadNotifyConfig(file: string): NotifyConfig {
  if (!existsSync(file)) return defaultNotifyConfig();
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    const d = defaultNotifyConfig();
    return {
      tools: { claude: !!j?.tools?.claude, codex: !!j?.tools?.codex, opencode: !!j?.tools?.opencode },
      webPush: !!j?.webPush,
      includeSummary: j?.includeSummary !== false,
      dedupeMs: typeof j?.dedupeMs === "number" ? j.dedupeMs : d.dedupeMs,
      webhooks: Array.isArray(j?.webhooks) ? j.webhooks : [],
    };
  } catch { return defaultNotifyConfig(); }
}

export function saveNotifyConfig(file: string, cfg: NotifyConfig): void {
  const tmp = join(dirname(file), `.notify.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}
