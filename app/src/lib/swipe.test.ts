import { test, expect } from "vitest";
import { detectSwipe } from "./swipe";

test("left swipe: dx negative, horizontal-dominant, quick", () => {
  expect(detectSwipe({ dx: -120, dy: 10, dt: 200 })).toBe("left");
});

test("right swipe: dx positive", () => {
  expect(detectSwipe({ dx: 120, dy: -10, dt: 200 })).toBe("right");
});

test("vertical scroll is rejected (dy dominant)", () => {
  expect(detectSwipe({ dx: 60, dy: 200, dt: 200 })).toBe(null);
});

test("too short is rejected", () => {
  expect(detectSwipe({ dx: 30, dy: 0, dt: 100 })).toBe(null);
});

test("too slow is rejected", () => {
  expect(detectSwipe({ dx: 200, dy: 0, dt: 1200 })).toBe(null);
});

test("custom thresholds honored", () => {
  expect(detectSwipe({ dx: 40, dy: 0, dt: 100 }, { minDist: 30 })).toBe("right");
});
