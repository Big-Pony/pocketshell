import { test, expect } from "vitest";
import { stateDotClass, needsKillConfirm, mergeSessions, tombstone, closeTab, type LocalSession } from "../src/lib/session-view";
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

test("mergeSessions upserts active and preserves order", () => {
  const local: LocalSession[] = [meta("a"), meta("b")];
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
