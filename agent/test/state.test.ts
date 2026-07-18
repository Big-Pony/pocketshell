import { test, expect } from "bun:test";
import { inferState, RUN_WINDOW_MS, StateHysteresis } from "../src/state";

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

// --- WP-3a: StateHysteresis (flip debounce over raw inferState output) ------

test("hysteresis: a single-tick blip does not flip the published state", () => {
  const h = new StateHysteresis("run");
  expect(h.next("wait")).toBe(false); // 1st consecutive observation: no flip
  expect(h.state).toBe("run");
});

test("hysteresis: two consecutive identical observations flip the state", () => {
  const h = new StateHysteresis("run");
  expect(h.next("wait")).toBe(false);
  expect(h.next("wait")).toBe(true); // 2nd consecutive: flip
  expect(h.state).toBe("wait");
});

test("hysteresis: alternating raw states never flip (run/wait抖动被打掉)", () => {
  const h = new StateHysteresis("run");
  // Bursty output: run, wait, run, wait... every candidate dies at streak 1.
  for (let i = 0; i < 10; i++) {
    expect(h.next(i % 2 === 0 ? "wait" : "run")).toBe(false);
  }
  expect(h.state).toBe("run");
});

test("hysteresis: returning to the published state resets the candidate streak", () => {
  const h = new StateHysteresis("run");
  expect(h.next("wait")).toBe(false); // streak 1
  expect(h.next("run")).toBe(false);  // back to published: streak reset
  expect(h.next("wait")).toBe(false); // streak 1 again, NOT 2
  expect(h.state).toBe("run");
  expect(h.next("wait")).toBe(true);  // now 2 consecutive
  expect(h.state).toBe("wait");
});

test("hysteresis: a different candidate restarts the streak", () => {
  const h = new StateHysteresis("run");
  expect(h.next("wait")).toBe(false); // candidate wait, streak 1
  expect(h.next("done")).toBe(false); // candidate switches to done, streak 1
  expect(h.next("done")).toBe(true);  // streak 2 -> flip to done
  expect(h.state).toBe("done");
});

test("hysteresis: after a flip, the next change needs its own 2-tick streak", () => {
  const h = new StateHysteresis("run");
  h.next("wait");
  h.next("wait"); // -> wait
  expect(h.next("run")).toBe(false);
  expect(h.state).toBe("wait");
  expect(h.next("run")).toBe(true);
  expect(h.state).toBe("run");
});

test("hysteresis: threshold is configurable", () => {
  const h = new StateHysteresis("run", 3);
  expect(h.next("wait")).toBe(false);
  expect(h.next("wait")).toBe(false);
  expect(h.state).toBe("run");
  expect(h.next("wait")).toBe(true);
  expect(h.state).toBe("wait");
});
