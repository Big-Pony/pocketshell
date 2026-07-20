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
