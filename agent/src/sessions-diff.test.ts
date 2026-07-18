import { test, expect } from "bun:test";
import { sessionListsEqual, sessionMetasEqual } from "./sessions-diff";
import type { SessionMeta } from "./protocol";

const base: SessionMeta = {
  name: "work",
  state: "run",
  cols: 80,
  rows: 24,
  lastLine: "$ vim",
  createdAt: 1700000000000,
  attached: true,
};

test("identical lists are equal (push is skipped)", () => {
  const a = [base, { ...base, name: "build", attached: false, state: "idle" as const }];
  // Different object identities, same content — the common list() recompute.
  const b = a.map((s) => ({ ...s }));
  expect(sessionListsEqual(a, b)).toBe(true);
});

test.each([
  ["state", { state: "wait" as const }],
  ["lastLine", { lastLine: "$ make" }],
  ["name", { name: "renamed" }],
  ["attached", { attached: false }],
  ["cols", { cols: 120 }],
  ["rows", { rows: 40 }],
  ["createdAt", { createdAt: 1 }],
])("a changed %s field is a diff (push happens)", (_label, patch) => {
  expect(sessionMetasEqual(base, { ...base, ...patch })).toBe(false);
  expect(sessionListsEqual([base], [{ ...base, ...patch }])).toBe(false);
});

test("length change is a diff", () => {
  expect(sessionListsEqual([base], [])).toBe(false);
  expect(sessionListsEqual([base], [base, base])).toBe(false);
});

test("order change is a diff (deterministic list order; costs one broadcast)", () => {
  const other = { ...base, name: "build" };
  expect(sessionListsEqual([base, other], [other, base])).toBe(false);
});
