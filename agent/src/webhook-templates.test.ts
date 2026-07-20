import { expect, test } from "bun:test";
import { buildWebhookBody, renderTemplate } from "./webhook-templates";

const msg = { sessionId: "w", title: "会话 w", body: 'done: "ok"\nline2', url: "https://app/?session=w", status: "done", time: "12:00" };

test("wecom text body", () => {
  expect(JSON.parse(buildWebhookBody("wecom", msg))).toEqual({ msgtype: "text", text: { content: "会话 w\ndone: \"ok\"\nline2" } });
});
test("slack text body", () => {
  expect(JSON.parse(buildWebhookBody("slack", msg)).text).toContain("会话 w");
});
test("discord content body", () => {
  expect(JSON.parse(buildWebhookBody("discord", msg)).content).toContain("会话 w");
});
test("feishu text body (sign added later by webhook-service)", () => {
  expect(JSON.parse(buildWebhookBody("feishu", msg))).toEqual({ msg_type: "text", content: { text: "会话 w\ndone: \"ok\"\nline2" } });
});
test("custom template does JSON-safe substitution", () => {
  const out = renderTemplate('{"t":{{title}},"b":{{body}}}', msg);
  expect(JSON.parse(out)).toEqual({ t: "会话 w", b: 'done: "ok"\nline2' }); // quotes/newlines survive
});
