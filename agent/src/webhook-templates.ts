// Per-platform webhook body builders + JSON-safe custom template rendering.
// Feishu signing (timestamp/sign fields) is added in webhook-service.ts, not
// here, because it needs the live clock + secret. renderTemplate injects values
// via JSON.stringify so a body/summary containing quotes or newlines cannot
// break out of the surrounding JSON.
import type { WebhookKind } from "./notify-config";

export interface NotifyMsg { sessionId: string; title: string; body: string; url: string; status: string; time: string; }

const combined = (m: NotifyMsg) => (m.body ? `${m.title}\n${m.body}` : m.title);

export function buildWebhookBody(kind: WebhookKind, msg: NotifyMsg, template?: string): string {
  switch (kind) {
    case "wecom": return JSON.stringify({ msgtype: "text", text: { content: combined(msg) } });
    case "feishu": return JSON.stringify({ msg_type: "text", content: { text: combined(msg) } });
    case "slack": return JSON.stringify({ text: combined(msg) });
    case "discord": return JSON.stringify({ content: combined(msg) });
    case "custom": return renderTemplate(template ?? '{"text":{{title}}}', msg);
  }
}

export function renderTemplate(template: string, msg: NotifyMsg): string {
  const vars: Record<string, string> = {
    title: msg.title, body: msg.body, session: msg.sessionId,
    status: msg.status, time: msg.time, url: msg.url,
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_m, k) => (k in vars ? JSON.stringify(vars[k]) : `{{${k}}}`));
}
