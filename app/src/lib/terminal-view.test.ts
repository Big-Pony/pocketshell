import { describe, it, expect } from "vitest";
import { virtualRows, scrollMode, VIRTUAL_ROW_FACTOR } from "./terminal-view";

describe("virtualRows", () => {
  it("keeps visible rows for the normal shell buffer", () => {
    expect(virtualRows(14, "normal")).toBe(14);
  });
  it("triples visible rows for the alternate (full-screen) buffer", () => {
    expect(virtualRows(14, "alternate")).toBe(42);
    expect(VIRTUAL_ROW_FACTOR).toBe(3);
  });
  it("never returns less than 1 row", () => {
    expect(virtualRows(0, "normal")).toBe(1);
    expect(virtualRows(-5, "alternate")).toBe(3);
  });
});

describe("scrollMode", () => {
  it("native for normal, container for alternate", () => {
    expect(scrollMode("normal")).toBe("native");
    expect(scrollMode("alternate")).toBe("container");
  });
});
