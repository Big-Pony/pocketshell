import { test, expect } from "vitest";
import { clampSplit } from "./shell";

test("clampSplit keeps a mid ratio unchanged", () => {
  expect(clampSplit(0.5)).toBe(0.5);
});
test("clampSplit floors and caps out-of-range ratios", () => {
  expect(clampSplit(0)).toBe(0.15);
  expect(clampSplit(1)).toBe(0.85);
  expect(clampSplit(-3)).toBe(0.15);
  expect(clampSplit(9)).toBe(0.85);
});
