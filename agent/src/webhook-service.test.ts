import { expect, test } from "bun:test";
import { sendWebhook } from "./webhook-service";
import type { WebhookCfg } from "./notify-config";

const msg = { sessionId: "w", title: "会话 w", body: "done", url: "https://app", status: "done", time: "12:00" };

test("feishu with secret adds timestamp+sign", async () => {
  let sent: any;
  const cfg: WebhookCfg = { id: "1", name: "t", kind: "feishu", url: "https://open.feishu", enabled: true, secret: "s" };
  const r = await sendWebhook(cfg, msg, { now: () => 1599360473000, fetch: async (_u, init) => { sent = JSON.parse(init.body); return { ok: true, status: 200 }; } });
  expect(r.ok).toBe(true);
  expect(sent.timestamp).toBe("1599360473");
  expect(typeof sent.sign).toBe("string");
  expect(sent.msg_type).toBe("text");
});

test("non-2xx returns error string", async () => {
  const cfg: WebhookCfg = { id: "1", name: "t", kind: "slack", url: "https://x", enabled: true };
  const r = await sendWebhook(cfg, msg, { fetch: async () => ({ ok: false, status: 500 }) });
  expect(r.ok).toBe(false);
  expect(r.error).toContain("500");
});
