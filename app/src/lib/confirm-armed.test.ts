import { test, expect } from "vitest";
import { IDLE, press } from "./confirm-armed";

test("first press arms without firing", () => {
  const r = press(IDLE, 1000);
  expect(r.fire).toBe(false);
  expect(r.state.armed).toBe(true);
});

test("second press within window fires and resets", () => {
  const a = press(IDLE, 1000);
  const b = press(a.state, 2500); // within 2000ms
  expect(b.fire).toBe(true);
  expect(b.state.armed).toBe(false);
});

test("second press after window re-arms instead of firing", () => {
  const a = press(IDLE, 1000);
  const b = press(a.state, 4000); // >2000ms later
  expect(b.fire).toBe(false);
  expect(b.state.armed).toBe(true);
  expect(b.state.armedAt).toBe(4000);
});
