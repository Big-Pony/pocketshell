import { test, expect } from "vitest";
import {
  stateDotClass, needsKillConfirm, nextSessionName, actionLabel, shouldAdopt, mergeSessions,
  tombstone, closeTab,
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

test("stateDotClass maps each state", () => {
  expect(stateDotClass("run")).toBe("dot-run");
  expect(stateDotClass("wait")).toBe("dot-wait");
  expect(stateDotClass("done")).toBe("dot-done");
});

test("needsKillConfirm only for live sessions", () => {
  expect(needsKillConfirm("run")).toBe(true);
  expect(needsKillConfirm("wait")).toBe(true);
  expect(needsKillConfirm("done")).toBe(false);
});

const sess = (name: string, state: SessionMeta["state"] = "run"): SessionMeta =>
  ({ name, kind: "tmux", state, cols: 80, rows: 24, lastLine: "", createdAt: 0, attached: false });

// A local the way mergeSessions actually emits it (closed materialized), so a
// no-change merge can keep the element reference instead of rebuilding it.
const localSess = (name: string, state: SessionMeta["state"] = "run"): LocalSession =>
  ({ ...sess(name, state), closed: false });

test("mergeSessions upserts active and preserves order", () => {
  const local: LocalSession[] = [localSess("a"), localSess("b")];
  const out = mergeSessions(local, [sess("a", "wait"), sess("b")]);
  expect(out.map((s) => [s.name, s.state, s.closed])).toEqual([["a", "wait", false], ["b", "run", false]]);
});

test("mergeSessions tombstones sessions absent from incoming", () => {
  const local: LocalSession[] = [sess("a"), sess("b")];
  const out = mergeSessions(local, [sess("a")]);
  const b = out.find((s) => s.name === "b")!;
  expect(b.closed).toBe(true);
  expect(b.state).toBe("done");
});

test("mergeSessions appends brand-new incoming sessions", () => {
  const out = mergeSessions([sess("a")], [sess("a"), sess("c")]);
  expect(out.map((s) => s.name)).toEqual(["a", "c"]);
});

test("tombstone marks one session closed+done", () => {
  const out = tombstone([sess("a"), sess("b")], "a");
  expect(out.find((s) => s.name === "a")).toMatchObject({ closed: true, state: "done" });
  expect(out.find((s) => s.name === "b")!.closed).toBeUndefined();
});

test("closeTab removes the session", () => {
  expect(closeTab([sess("a"), sess("b")], "a").map((s) => s.name)).toEqual(["b"]);
});

test("actionLabel returns close for a tombstone", () => {
  expect(actionLabel({ name: "s1", kind: "tmux", state: "done", cols: 80, rows: 24, lastLine: "", createdAt: 0, attached: false, closed: true })).toBe("close");
});

// ──────────────────────────────────────────────────────────────
// WP-3b (R5): reference preservation — a no-change broadcast returns the same
// array/element refs so App's $state sees no update and the tab strip,
// TaskPanel and the persist $effect stay idle
// ──────────────────────────────────────────────────────────────
test("mergeSessions returns the same array reference when nothing changed", () => {
  const tomb = { ...sess("b"), closed: true, state: "done" as const };
  const local: LocalSession[] = [sess("a"), tomb];
  const out = mergeSessions(local, [sess("a")]);
  expect(out).toBe(local);          // whole-array ref kept
  expect(out[0]).toBe(local[0]);    // unchanged element keeps its object ref
  expect(out[1]).toBe(local[1]);    // an existing tombstone is not re-created
});

test("mergeSessions produces new refs only where fields changed", () => {
  const local: LocalSession[] = [sess("a"), sess("b")];
  const out = mergeSessions(local, [sess("a", "wait"), sess("b")]);
  expect(out).not.toBe(local);
  expect(out[0]).not.toBe(local[0]); // state run->wait: new object
  expect(out[0]).toMatchObject({ name: "a", state: "wait", closed: false });
  expect(out[1]).toBe(local[1]);     // untouched: same object
});

test("mergeSessions: added/removed sessions yield a new array but keep surviving refs", () => {
  const local: LocalSession[] = [sess("a"), sess("b")];
  const added = mergeSessions(local, [sess("a"), sess("b"), sess("c")]);
  expect(added).not.toBe(local);
  expect(added[0]).toBe(local[0]);
  expect(added[1]).toBe(local[1]);

  const removed = mergeSessions(local, [sess("a")]); // b disappears -> tombstone transition
  expect(removed).not.toBe(local);
  expect(removed[0]).toBe(local[0]);
  expect(removed[1]).not.toBe(local[1]);
  expect(removed[1]).toMatchObject({ name: "b", closed: true, state: "done" });

  // ...and once tombstoned, the next identical broadcast is stable again
  expect(mergeSessions(removed, [sess("a")])).toBe(removed);
});
