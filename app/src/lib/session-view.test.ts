import { test, expect } from "vitest";
import {
  stateDotClass, needsKillConfirm, nextSessionName, actionLabel, shouldAdopt, mergeSessions,
  type LocalSession,
} from "./session-view";
import type { SessionMeta } from "./protocol";

const meta = (over: Partial<SessionMeta> = {}): SessionMeta => ({
  name: "s1", kind: "tmux", state: "run", cols: 80, rows: 24, lastLine: "", createdAt: 0, attached: true, ...over,
});

test("stateDotClass maps idle to dot-idle", () => {
  expect(stateDotClass("idle")).toBe("dot-idle");
});

test("needsKillConfirm: true for idle (activity unknown), false only for done", () => {
  expect(needsKillConfirm("idle")).toBe(true);
  expect(needsKillConfirm("run")).toBe(true);
  expect(needsKillConfirm("wait")).toBe(true);
  expect(needsKillConfirm("done")).toBe(false);
});

test("nextSessionName picks the lowest free sN, skipping taken (incl. foreign names)", () => {
  expect(nextSessionName([])).toBe("s1");
  expect(nextSessionName(["s1", "s2"])).toBe("s3");
  expect(nextSessionName(["s1", "s3"])).toBe("s2");   // fills the hole
  expect(nextSessionName(["s2", "work"])).toBe("s1");  // non-sN names ignored
});

test("actionLabel: open for un-adopted, enter for adopted, close for tombstone", () => {
  expect(actionLabel(meta({ attached: false, state: "idle" }) as LocalSession)).toBe("open");
  expect(actionLabel(meta({ attached: true }) as LocalSession)).toBe("enter");
  expect(actionLabel({ ...meta(), closed: true } as LocalSession)).toBe("close");
});

test("shouldAdopt only for live un-adopted sessions", () => {
  expect(shouldAdopt(meta({ attached: false }) as LocalSession)).toBe(true);
  expect(shouldAdopt(meta({ attached: true }) as LocalSession)).toBe(false);
  expect(shouldAdopt({ ...meta({ attached: false }), closed: true } as LocalSession)).toBe(false);
});

test("mergeSessions keeps foreign incoming (no flicker) and tombstones the truly gone", () => {
  const local: LocalSession[] = [{ ...meta({ name: "s1", attached: true }) }];
  const incoming: SessionMeta[] = [
    meta({ name: "s1", attached: true }),
    meta({ name: "work", state: "idle", attached: false }),
  ];
  const merged = mergeSessions(local, incoming);
  expect(merged.map((s) => s.name)).toEqual(["s1", "work"]);
  expect(merged.find((s) => s.name === "work")!.closed).toBe(false);

  const merged2 = mergeSessions(merged, [meta({ name: "work", state: "idle", attached: false })]);
  expect(merged2.find((s) => s.name === "s1")!.closed).toBe(true); // s1 gone -> tombstone
});
