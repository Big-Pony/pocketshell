import { test, expect } from "vitest";
import { keyboardHeight, isKeyboardOpen } from "../src/lib/keyboard-inset";

test("keyboardHeight is layout height minus visual viewport bottom", () => {
  // 844 tall layout; keyboard shrinks visual viewport to 544 at offsetTop 0.
  expect(keyboardHeight({ innerHeight: 844, vvHeight: 544, vvOffsetTop: 0 })).toBe(300);
});

test("keyboardHeight is 0 when the visual viewport fills the layout", () => {
  expect(keyboardHeight({ innerHeight: 844, vvHeight: 844, vvOffsetTop: 0 })).toBe(0);
});

test("keyboardHeight never goes negative", () => {
  expect(keyboardHeight({ innerHeight: 844, vvHeight: 900, vvOffsetTop: 0 })).toBe(0);
});

test("isKeyboardOpen uses a threshold", () => {
  expect(isKeyboardOpen({ innerHeight: 844, vvHeight: 544, vvOffsetTop: 0 })).toBe(true);
  expect(isKeyboardOpen({ innerHeight: 844, vvHeight: 800, vvOffsetTop: 0 })).toBe(false);
});
