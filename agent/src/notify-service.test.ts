import { expect, test } from "bun:test";
import { decideDispatch } from "./notify-service";

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
