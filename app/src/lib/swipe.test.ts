import { test, expect, describe } from "vitest";
import { detectSwipe, makeSwipeTracker } from "./swipe";

const pt = (clientX: number, clientY: number, timeStamp: number) => ({ clientX, clientY, timeStamp });

describe("makeSwipeTracker", () => {
  test("down→move→up fires the swipe direction", () => {
    const seen: string[] = [];
    const tr = makeSwipeTracker((d) => seen.push(d));
    tr.down(pt(0, 0, 0));
    tr.move(pt(-120, 5, 200));
    tr.up(pt(-120, 5, 200));
    expect(seen).toEqual(["left"]);
  });

  test("pointercancel still evaluates the gesture from the last move (fallback)", () => {
    // The whole point of the fix: a scrollable child steals the touch and the
    // browser fires pointercancel instead of pointerup.
    const seen: string[] = [];
    const tr = makeSwipeTracker((d) => seen.push(d));
    tr.down(pt(0, 0, 0));
    tr.move(pt(130, 8, 220));
    tr.cancel();
    expect(seen).toEqual(["right"]);
  });

  test("a vertical drag that is cancelled does not switch (dy dominant)", () => {
    const seen: string[] = [];
    const tr = makeSwipeTracker((d) => seen.push(d));
    tr.down(pt(0, 0, 0));
    tr.move(pt(6, 200, 220));
    tr.cancel();
    expect(seen).toEqual([]);
  });

  test("cancel with no prior move/start is a no-op (no leak into next gesture)", () => {
    const seen: string[] = [];
    const tr = makeSwipeTracker((d) => seen.push(d));
    tr.cancel();
    tr.down(pt(0, 0, 0));
    tr.up(pt(-120, 0, 100)); // fresh gesture unaffected
    expect(seen).toEqual(["left"]);
  });

  test("up after a completed gesture does not double-fire", () => {
    const seen: string[] = [];
    const tr = makeSwipeTracker((d) => seen.push(d));
    tr.down(pt(0, 0, 0));
    tr.up(pt(-120, 0, 100));
    tr.up(pt(-120, 0, 100)); // start already cleared
    expect(seen).toEqual(["left"]);
  });
});

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
