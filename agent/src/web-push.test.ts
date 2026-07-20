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
  expect(r).toEqual({ ok: false, gone: true });
});

test("2xx is ok", async () => {
  const r = await sendPush(async () => ({ statusCode: 201 }), { pubKey: "A", subscription: {} }, "x");
  expect(r).toEqual({ ok: true, gone: false });
});
