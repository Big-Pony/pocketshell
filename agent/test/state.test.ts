import { test, expect } from "bun:test";
import { inferState, RUN_WINDOW_MS } from "../src/state";

test("no tmux session -> done", () => {
  expect(inferState({ hasSession: false, lastOutputAt: 1000, now: 1000 })).toBe("done");
});

test("recent output within window -> run", () => {
  expect(inferState({ hasSession: true, lastOutputAt: 1000, now: 1000 + RUN_WINDOW_MS - 1 })).toBe("run");
});

test("silent past window -> wait", () => {
  expect(inferState({ hasSession: true, lastOutputAt: 1000, now: 1000 + RUN_WINDOW_MS + 1 })).toBe("wait");
});

test("exactly at window boundary -> wait (window is exclusive)", () => {
  expect(inferState({ hasSession: true, lastOutputAt: 1000, now: 1000 + RUN_WINDOW_MS })).toBe("wait");
});
