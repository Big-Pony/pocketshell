import { test, expect } from "vitest";
import { stateDotClass, needsKillConfirm, mergeSessions, tombstone, closeTab, actionLabel, type LocalSession } from "../src/lib/session-view";
import type { SessionMeta } from "../src/lib/protocol";

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

const meta = (name: string, state: SessionMeta["state"] = "run"): SessionMeta =>
  ({ name, state, cols: 80, rows: 24, lastLine: "", createdAt: 0 });

// A local the way mergeSessions actually emits it (closed materialized), so a
// no-change merge can keep the element reference instead of rebuilding it.
const localMeta = (name: string, state: SessionMeta["state"] = "run"): LocalSession =>
  ({ ...meta(name, state), closed: false });

test("mergeSessions upserts active and preserves order", () => {
  const local: LocalSession[] = [localMeta("a"), localMeta("b")];
  const out = mergeSessions(local, [meta("a", "wait"), meta("b")]);
  expect(out.map((s) => [s.name, s.state, s.closed])).toEqual([["a", "wait", false], ["b", "run", false]]);
});

test("mergeSessions tombstones sessions absent from incoming", () => {
  const local: LocalSession[] = [meta("a"), meta("b")];
  const out = mergeSessions(local, [meta("a")]);
  const b = out.find((s) => s.name === "b")!;
  expect(b.closed).toBe(true);
  expect(b.state).toBe("done");
});

test("mergeSessions appends brand-new incoming sessions", () => {
  const out = mergeSessions([meta("a")], [meta("a"), meta("c")]);
  expect(out.map((s) => s.name)).toEqual(["a", "c"]);
});

test("tombstone marks one session closed+done", () => {
  const out = tombstone([meta("a"), meta("b")], "a");
  expect(out.find((s) => s.name === "a")).toMatchObject({ closed: true, state: "done" });
  expect(out.find((s) => s.name === "b")!.closed).toBeUndefined();
});

test("closeTab removes the session", () => {
  expect(closeTab([meta("a"), meta("b")], "a").map((s) => s.name)).toEqual(["b"]);
});

test("actionLabel returns close for a tombstone", () => {
  expect(actionLabel({ name: "s1", state: "done", cols: 80, rows: 24, lastLine: "", createdAt: 0, attached: false, closed: true })).toBe("close");
});

// ──────────────────────────────────────────────────────────────
// WP-3b (R5): reference preservation — a no-change broadcast returns the same
// array/element refs so App's $state sees no update and the tab strip,
// TaskPanel and the persist $effect stay idle
// ──────────────────────────────────────────────────────────────
test("mergeSessions returns the same array reference when nothing changed", () => {
  const tomb = { ...meta("b"), closed: true, state: "done" as const };
  const local: LocalSession[] = [meta("a"), tomb];
  const out = mergeSessions(local, [meta("a")]);
  expect(out).toBe(local);          // whole-array ref kept
  expect(out[0]).toBe(local[0]);    // unchanged element keeps its object ref
  expect(out[1]).toBe(local[1]);    // an existing tombstone is not re-created
});

test("mergeSessions produces new refs only where fields changed", () => {
  const local: LocalSession[] = [meta("a"), meta("b")];
  const out = mergeSessions(local, [meta("a", "wait"), meta("b")]);
  expect(out).not.toBe(local);
  expect(out[0]).not.toBe(local[0]); // state run->wait: new object
  expect(out[0]).toMatchObject({ name: "a", state: "wait", closed: false });
  expect(out[1]).toBe(local[1]);     // untouched: same object
});

test("mergeSessions: added/removed sessions yield a new array but keep surviving refs", () => {
  const local: LocalSession[] = [meta("a"), meta("b")];
  const added = mergeSessions(local, [meta("a"), meta("b"), meta("c")]);
  expect(added).not.toBe(local);
  expect(added[0]).toBe(local[0]);
  expect(added[1]).toBe(local[1]);

  const removed = mergeSessions(local, [meta("a")]); // b disappears -> tombstone transition
  expect(removed).not.toBe(local);
  expect(removed[0]).toBe(local[0]);
  expect(removed[1]).not.toBe(local[1]);
  expect(removed[1]).toMatchObject({ name: "b", closed: true, state: "done" });

  // ...and once tombstoned, the next identical broadcast is stable again
  expect(mergeSessions(removed, [meta("a")])).toBe(removed);
});
