import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { decideDispatch, NotificationService } from "./notify-service";

const P = (pubKey: string, fg: boolean, active: string | null) => ({ pubKey, foreground: fg, activeSessionId: active });

test("dedupe within window returns null", () => {
  expect(decideDispatch({ sessionId: "w", lastTs: 1000, now: 1500, dedupeMs: 10000, presences: [] })).toBeNull();
});

test("device watching the session in foreground is skipped for push", () => {
  const d = decideDispatch({ sessionId: "w", lastTs: undefined, now: 20000, dedupeMs: 10000,
    presences: [P("A", true, "w"), P("B", true, "other"), P("C", false, "w")] });
  expect(d).not.toBeNull();
  expect(d!.inApp).toBe(true);
  expect(d!.pushPubKeys.sort()).toEqual(["B", "C"]); // A is watching w -> skipped
  expect(d!.webhook).toBe(true);
});

test("no presence info -> push all offline-eligible + webhook", () => {
  const d = decideDispatch({ sessionId: "w", lastTs: undefined, now: 1, dedupeMs: 10000, presences: [] });
  expect(d!.pushPubKeys).toEqual([]); // no known devices; push targets resolved from subs elsewhere
  expect(d!.webhook).toBe(true);
});

function svc(overrides: any = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ns-"));
  const inApp: any[] = []; const pushed: string[] = []; const hooks: string[] = [];
  const s = new NotificationService({
    keyDir: dir,
    getPresences: overrides.getPresences ?? (() => []),
    broadcastInApp: (m) => inApp.push(m),
    pushSender: async () => { pushed.push("p"); return { statusCode: 201 }; },
    webhookSend: async () => { hooks.push("w"); return { ok: true }; },
    now: overrides.now ?? (() => 100000),
  });
  return { s, inApp, pushed, hooks, dir };
}

test("dispatch broadcasts in-app and dedupes second within window", async () => {
  const { s, inApp } = svc();
  const c = s.config(); c.webPush = false; s.setConfig(c);
  await s.dispatch({ sessionId: "w", title: "w", body: "done" });
  await s.dispatch({ sessionId: "w", title: "w", body: "again" });
  expect(inApp.length).toBe(1); // second deduped (same session, <10s)
});

test("enabled webhook fires", async () => {
  const { s, hooks } = svc();
  const c = s.config();
  c.webhooks.push({ id: "1", name: "t", kind: "slack", url: "https://x", enabled: true });
  s.setConfig(c);
  await s.dispatch({ sessionId: "w", title: "w", body: "done" });
  expect(hooks.length).toBe(1);
});

// 发送失败原先完全静默：设置面板显示 Web Push 开着，用户却收不到推送，也看
// 不出是这台服务器发不出去（最常见：连不上 fcm.googleapis.com）。像 webhook
// 的 lastError 一样记下来，回报到 UI。
function failingSvc(err: Error) {
  const dir = mkdtempSync(join(tmpdir(), "ns-"));
  const s = new NotificationService({
    keyDir: dir,
    getPresences: () => [],
    broadcastInApp: () => {},
    pushSender: async () => { throw err; },
    webhookSend: async () => ({ ok: true }),
    now: () => 100000,
  });
  s.addSub("A", { endpoint: "A" });
  const c = s.config(); c.webPush = true; s.setConfig(c);
  return s;
}

test("push send failure is recorded as webPushLastError", async () => {
  const s = failingSvc(new Error("connect ECONNREFUSED 127.0.0.1:7890"));
  await s.dispatch({ sessionId: "w", title: "w", body: "done" });
  expect(s.config().webPushLastError).toBe("connect ECONNREFUSED 127.0.0.1:7890");
});

test("a later successful push clears webPushLastError", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ns-"));
  let fail = true;
  const s = new NotificationService({
    keyDir: dir,
    getPresences: () => [],
    broadcastInApp: () => {},
    pushSender: async () => { if (fail) throw new Error("boom"); return { statusCode: 201 }; },
    webhookSend: async () => ({ ok: true }),
    now: (() => { let t = 0; return () => (t += 100000); })(),
  });
  s.addSub("A", { endpoint: "A" });
  const c = s.config(); c.webPush = true; s.setConfig(c);
  await s.dispatch({ sessionId: "w", title: "w", body: "done" });
  expect(s.config().webPushLastError).toBe("boom");
  fail = false;
  await s.dispatch({ sessionId: "w", title: "w", body: "done" });
  expect(s.config().webPushLastError).toBeNull();
});

test("webPushLastError survives a restart (persisted to notify.json)", async () => {
  const s = failingSvc(new Error("boom"));
  await s.dispatch({ sessionId: "w", title: "w", body: "done" });
  // 新实例从同一 keyDir 重新加载：错误必须还在，否则 agent 重启后 UI 又变回
  // 「一切正常」的假象。
  const dir = (s as unknown as { deps: { keyDir: string } }).deps.keyDir;
  const s2 = new NotificationService({
    keyDir: dir, getPresences: () => [], broadcastInApp: () => {},
    pushSender: async () => ({ statusCode: 201 }), now: () => 1,
  });
  expect(s2.config().webPushLastError).toBe("boom");
});

test("dispatch with webPush on pushes only to the backgrounded device", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ns-"));
  const pushedSubs: unknown[] = [];
  const s = new NotificationService({
    keyDir: dir,
    getPresences: () => [P("A", true, "w"), P("B", false, "other")],
    broadcastInApp: () => {},
    pushSender: async (subscription) => { pushedSubs.push(subscription); return { statusCode: 201 }; },
    now: () => 100000,
  });
  s.addSub("A", { endpoint: "A" });
  s.addSub("B", { endpoint: "B" });
  const c = s.config(); c.webPush = true; s.setConfig(c);
  await s.dispatch({ sessionId: "w", title: "w", body: "done" });
  // A is foreground and watching session "w" -> skipped; only B (background) gets the push.
  expect(pushedSubs.length).toBe(1);
  expect(pushedSubs[0]).toEqual({ endpoint: "B" });
});
