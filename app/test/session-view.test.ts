import { test, expect } from "vitest";
import { stateDotClass, needsKillConfirm } from "../src/lib/session-view";

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
