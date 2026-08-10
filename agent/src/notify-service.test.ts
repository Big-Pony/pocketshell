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

// ---------------------------------------------------------------------------
// 诊断推送（14 期需求 4）
//
// 只回报"推送服务是否受理"（HTTP 层）。是否真正送达由前端 SW 回报——
// 生产实证：FCM 对已轮换的 endpoint 在宽限期内仍返回 201，只看状态码
// 会得出"一切正常"的错误结论。
// ---------------------------------------------------------------------------

function diagSvc(sender: (sub: unknown, payload: string) => Promise<{ statusCode: number }>) {
  const dir = mkdtempSync(join(tmpdir(), "ns-diag-"));
  return new NotificationService({
    keyDir: dir,
    getPresences: () => [],
    broadcastInApp: () => {},
    pushSender: sender,
    webhookSend: async () => ({ ok: true }),
    now: () => 100000,
  });
}

test("testPushTo 只发给指定设备，载荷带 diag 标记", async () => {
  const seen: string[] = [];
  const subs: unknown[] = [];
  const s = diagSvc(async (sub, payload) => { subs.push(sub); seen.push(payload); return { statusCode: 201 }; });
  s.addSub("A", { endpoint: "epA" });
  s.addSub("B", { endpoint: "epB" });
  const r = await s.testPushTo("A");
  expect(r.ok).toBe(true);
  expect(subs).toEqual([{ endpoint: "epA" }]); // 不广播：测的是"我这台收不收得到"
  expect(JSON.parse(seen[0]!).diag).toBe(true); // sw.js 据此识别并回报
});

test("testPushTo 对没有订阅的设备回 no_subscription 而不是假装成功", async () => {
  const s = diagSvc(async () => { throw new Error("不该被调用"); });
  const r = await s.testPushTo("NOBODY");
  expect(r.ok).toBe(false);
  expect(r.error).toBe("no_subscription");
});

test("testPushTo 遇 410 清掉死订阅", async () => {
  const s = diagSvc(async () => { const e: any = new Error("gone"); e.statusCode = 410; throw e; });
  s.addSub("A", { endpoint: "epA" });
  const r = await s.testPushTo("A");
  expect(r.ok).toBe(false);
  // 订阅已被清掉：再测一次得到的是 no_subscription 而不是又一次 410
  expect((await s.testPushTo("A")).error).toBe("no_subscription");
});

test("testPushTo 把发送失败的原因带出来（不吞错）", async () => {
  const s = diagSvc(async () => { throw new Error("connect ETIMEDOUT"); });
  s.addSub("A", { endpoint: "epA" });
  const r = await s.testPushTo("A");
  expect(r.ok).toBe(false);
  expect(r.error).toContain("ETIMEDOUT");
});
