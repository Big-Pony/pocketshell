// Pure helpers for the notification feature (unit-tested; no DOM/network).
export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// 浏览器订阅失败时抛的是给开发者看的英文原文（Chrome 最典型的一句
// "Registration failed - push service error"），用户看到只会一脸茫然。这里把
// 认得出的几种映射成 i18n key，认不出的返回 null 让调用方原样显示错误文本
// ——宁可露出英文原文，也不吞掉未知错误。
export function webPushErrorKey(e: unknown): string | null {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  // Chrome 要向 FCM 注册才能拿到订阅端点；国内网络够不着 fcm.googleapis.com
  // 就是这一句，与 VAPID 密钥、SW、权限都无关（实测：baidu/github 443 通、
  // fcm.googleapis.com 443 不通时必现）。
  if (msg.includes("push service error")) return "notify.webpush.err.unreachable";
  if (msg.includes("no active service worker")) return "notify.webpush.err.noWorker";
  return null;
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
  tools: { claude: boolean; codex: boolean; opencode: boolean; kimi: boolean };
  webPush: boolean; includeSummary: boolean; dedupeMs: number; webhooks: WebhookCfg[];
  /** 需求 5：接管 Claude Code 的 statusLine 以获取上下文用量。与 tools.* 不同
   *  ——它不产生任何通知，只取数字，所以单列一个字段而不是塞进 tools。 */
  contextStatusline: boolean;
}

export function defaultNotifyConfig(): NotifyConfig {
  return { tools: { claude: false, codex: false, opencode: false, kimi: false }, webPush: false, includeSummary: true, dedupeMs: 10000, webhooks: [], contextStatusline: false };
}
