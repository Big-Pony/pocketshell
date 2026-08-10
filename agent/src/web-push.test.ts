import { expect, test } from "bun:test";
import { upsertSub, removeSubsForDevice, sendPush } from "./web-push";

test("upsert replaces same device", () => {
  let subs = upsertSub([], { pubKey: "A", subscription: { endpoint: "e1" } });
  subs = upsertSub(subs, { pubKey: "A", subscription: { endpoint: "e2" } });
  expect(subs.length).toBe(1);
  expect((subs[0].subscription as any).endpoint).toBe("e2");
});

test("removeSubsForDevice drops the device", () => {
  const subs = [{ pubKey: "A", subscription: {} }, { pubKey: "B", subscription: {} }];
  expect(removeSubsForDevice(subs, "A")).toEqual([{ pubKey: "B", subscription: {} }]);
});

test("410 marks subscription gone", async () => {
  const r = await sendPush(async () => { const e: any = new Error("gone"); e.statusCode = 410; throw e; }, { pubKey: "A", subscription: {} }, "x");
  // 失效订阅走 gone:true 被回收，error 只是附带信息（统一成 status 形式）
  expect(r).toEqual({ ok: false, gone: true, error: "status 410" });
});

test("2xx is ok", async () => {
  const r = await sendPush(async () => ({ statusCode: 201 }), { pubKey: "A", subscription: {} }, "x");
  expect(r).toEqual({ ok: true, gone: false });
});

// 发送失败的原因原先被整个吞掉（只剩 ok/gone 两个 bool），用户在设置面板里
// 看到 Web Push 开着却收不到推送，无从知道是服务器发不出去。带出原因才能像
// webhook 的 lastError 那样回报到 UI。
test("network failure carries the reason out", async () => {
  const r = await sendPush(async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:7890"); }, { pubKey: "A", subscription: {} }, "x");
  expect(r.ok).toBe(false);
  expect(r.gone).toBe(false);
  expect(r.error).toBe("connect ECONNREFUSED 127.0.0.1:7890");
});

test("non-2xx without an exception carries a status-based reason", async () => {
  const r = await sendPush(async () => ({ statusCode: 500 }), { pubKey: "A", subscription: {} }, "x");
  expect(r.ok).toBe(false);
  expect(r.gone).toBe(false);
  expect(r.error).toBe("status 500");
});

// web-push 库把所有 HTTP 层失败统一抛成 "Received unexpected response code"，
// 真正的信息在 statusCode 和 body 上（实证：VAPID 密钥不匹配时 message 是那
// 句通用文本，body 才写着 "the VAPID credentials ... do not correspond"）。
// 只取 message 等于把诊断信息丢光。
test("http-level failure carries status and body, not the library's generic message", async () => {
  const r = await sendPush(async () => {
    const e: any = new Error("Received unexpected response code");
    e.statusCode = 403;
    e.body = "the VAPID credentials in the authorization header do not correspond to the credentials used to create the subscriptions.\n";
    throw e;
  }, { pubKey: "A", subscription: {} }, "x");
  expect(r.ok).toBe(false);
  // gone 从 false 改成 true 是 14 期需求 4 的刻意行为变更，见下方 403 用例：
  // 这里只关心「诊断信息有没有被丢光」，清理与否由那条用例负责。
  expect(r.gone).toBe(true);
  expect(r.error).toContain("403");
  expect(r.error).toContain("VAPID credentials");
});

test("an error with no body falls back to its message", async () => {
  const r = await sendPush(async () => { throw new Error("socket hang up"); }, { pubKey: "A", subscription: {} }, "x");
  expect(r.error).toBe("socket hang up");
});

// 14 期需求 4（R7 配套）：403 = VAPID 密钥对不上（换服务器/重生成密钥后
// 旧订阅会得到它，body 明说"the VAPID credentials do not correspond"）。
// 此前不算 gone，于是坏订阅永久卡在 push-subs.json 里，每次都失败、
// 每次都不清理。与 410/404 同等对待即可——下次连接时前端会自动重建。
test("403 也算 gone，坏订阅要被清掉", async () => {
  const r = await sendPush(async () => {
    const e: any = new Error("Received unexpected response code");
    e.statusCode = 403;
    e.body = "the VAPID credentials in the authorization header do not correspond to the credentials used to create the subscription";
    throw e;
  }, { pubKey: "A", subscription: {} }, "x");
  expect(r.ok).toBe(false);
  expect(r.gone, "403 应触发订阅清理").toBe(true);
  expect(r.error).toContain("403");
});
