// Pure helpers for the notification feature (unit-tested; no DOM/network).
export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function sessionFromUrl(search: string): string | null {
  const v = new URLSearchParams(search).get("session");
  return v && v.length > 0 ? v : null;
}

// Mirrors agent/src/notify-config.ts NotifyConfig/WebhookCfg — notify.getConfig /
// notify.setConfig carry this shape over the wire as an opaque `unknown`, so the
// frontend keeps its own copy of the type instead of importing across packages.
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
