import { describe, it, expect } from "vitest";
import { withinTouchSlop, TOUCH_SLOP } from "./touch-select";

describe("withinTouchSlop", () => {
  it("keeps a stationary long-press within slop (suppress scroll)", () => {
    expect(withinTouchSlop(0, 0)).toBe(true);
  });
  it("keeps small finger jitter within slop", () => {
    expect(withinTouchSlop(5, -4)).toBe(true);
    expect(withinTouchSlop(TOUCH_SLOP, TOUCH_SLOP)).toBe(true);
  });
  it("releases once the finger clearly moves (a real drag)", () => {
    expect(withinTouchSlop(0, TOUCH_SLOP + 1)).toBe(false);
    expect(withinTouchSlop(40, 0)).toBe(false);
    expect(withinTouchSlop(-30, 30)).toBe(false);
  });
  it("honors a custom slop", () => {
    expect(withinTouchSlop(15, 0, 20)).toBe(true);
    expect(withinTouchSlop(25, 0, 20)).toBe(false);
  });
});
