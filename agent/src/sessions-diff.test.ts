import { test, expect } from "bun:test";
import { sessionListsEqual, sessionMetasEqual } from "./sessions-diff";
import type { SessionMeta } from "./protocol";

const base: SessionMeta = {
  name: "work",
  kind: "tmux",
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

test("token 字段变化会被判定为不相等（否则广播被 diff 吃掉，功能静默失效）", () => {
  const bare: SessionMeta = {
    name: "w", kind: "tmux", state: "run", cols: 80, rows: 24,
    lastLine: "", createdAt: 0, attached: true,
  };
  expect(sessionMetasEqual(bare, { ...bare, ctxUsed: 100 })).toBe(false);
  expect(sessionMetasEqual({ ...bare, ctxUsed: 100 }, { ...bare, ctxUsed: 200 })).toBe(false);
  expect(sessionMetasEqual({ ...bare, ctxTotal: 1 }, { ...bare, ctxTotal: 2 })).toBe(false);
  expect(sessionMetasEqual({ ...bare, ctxTool: "kimi" }, { ...bare, ctxTool: "claude" })).toBe(false);
  expect(sessionMetasEqual({ ...bare, ctxUsed: 100 }, { ...bare, ctxUsed: 100 })).toBe(true);
});
