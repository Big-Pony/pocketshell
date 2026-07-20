// Sends one webhook. Injects Feishu timestamp+sign when a secret is set (built
// bodies from webhook-templates never include signing — that needs the live
// clock here). 8s timeout via AbortController; any failure becomes a short
// error string the caller stores on cfg.lastError for the UI. HTTPS_PROXY is
// honored by Bun's fetch automatically.
import type { WebhookCfg } from "./notify-config";
import { buildWebhookBody, type NotifyMsg } from "./webhook-templates";
import { feishuSign } from "./feishu-sign";

export type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number }>;

export async function sendWebhook(
  cfg: WebhookCfg, msg: NotifyMsg,
  deps: { fetch?: Fetcher; now?: () => number; timeoutMs?: number } = {},
): Promise<{ ok: boolean; error?: string }> {
  const now = deps.now ?? (() => Date.now());
  const doFetch: Fetcher = deps.fetch ?? (async (url, init) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), deps.timeoutMs ?? 8000);
    try { const r = await fetch(url, { ...init, signal: ctl.signal }); return { ok: r.ok, status: r.status }; }
    finally { clearTimeout(t); }
  });
  try {
    let body = buildWebhookBody(cfg.kind, msg, cfg.template);
    const method = cfg.kind === "custom" && cfg.method ? cfg.method : "POST";
    const headers: Record<string, string> = { "content-type": "application/json", ...(cfg.headers ?? {}) };
    if (cfg.kind === "feishu" && cfg.secret) {
      const ts = Math.floor(now() / 1000);
      const obj = JSON.parse(body);
      obj.timestamp = String(ts);
      obj.sign = feishuSign(cfg.secret, ts);
      body = JSON.stringify(obj);
    }
    const r = await doFetch(cfg.url, { method, headers, body });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    return { ok: true };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}
