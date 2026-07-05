import { test, expect } from "vitest";
import { IDLE, begin, moveFocus, range, reset } from "./terminal-select";

test("begin snapshots anchor=focus at cursor and enters selecting", () => {
  const s = begin({ row: 10, col: 5 });
  expect(s.mode).toBe("selecting");
  expect(s.anchor).toEqual({ row: 10, col: 5 });
  expect(s.focus).toEqual({ row: 10, col: 5 });
});

test("range at anchor==focus is a single cell (length 1)", () => {
  const s = begin({ row: 10, col: 5 });
  expect(range(s, 80)).toEqual({ col: 5, row: 10, length: 1 });
});

test("moveFocus clamps to bounds and does nothing when idle", () => {
  expect(moveFocus(IDLE, "up", { cols: 80, maxRow: 100 })).toBe(IDLE);
  const s = begin({ row: 0, col: 0 });
  const up = moveFocus(s, "up", { cols: 80, maxRow: 100 });   // row can't go below 0
  expect(up.focus).toEqual({ row: 0, col: 0 });
  const left = moveFocus(s, "left", { cols: 80, maxRow: 100 }); // col can't go below 0
  expect(left.focus).toEqual({ row: 0, col: 0 });
});

test("forward selection: focus below/after anchor", () => {
  let s = begin({ row: 2, col: 3 });
  s = moveFocus(s, "down", { cols: 10, maxRow: 100 }); // focus row 3
  s = moveFocus(s, "right", { cols: 10, maxRow: 100 }); // focus col 4
  // start=(2,3) end=(3,4): length = (3-2)*10 + (4-3) + 1 = 12
  expect(range(s, 10)).toEqual({ col: 3, row: 2, length: 12 });
});

test("reverse selection: focus above/before anchor normalizes start=focus", () => {
  let s = begin({ row: 5, col: 6 });
  s = moveFocus(s, "up", { cols: 10, maxRow: 100 });   // focus row 4
  s = moveFocus(s, "left", { cols: 10, maxRow: 100 });  // focus col 5
  // anchor=(5,6) focus=(4,5): start=(4,5) end=(5,6): length=(5-4)*10+(6-5)+1=12
  expect(range(s, 10)).toEqual({ col: 5, row: 4, length: 12 });
});

test("reset returns idle", () => {
  expect(reset().mode).toBe("idle");
});
