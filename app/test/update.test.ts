import { describe, it, expect } from "vitest";
import { phaseLabelKey, hasUpdate, compareSemver } from "../src/lib/update";

describe("update pure logic", () => {
  it("phaseLabelKey maps each phase", () => {
    expect(phaseLabelKey("downloading")).toBe("update.phase.downloading");
    expect(phaseLabelKey("error")).toBe("update.phase.error");
    expect(phaseLabelKey("weird")).toBe("update.phase.working");
  });
  it("hasUpdate/compareSemver", () => {
    expect(compareSemver("0.3.0", "0.4.0")).toBe(-1);
    expect(hasUpdate("0.3.0", "0.4.0")).toBe(true);
    expect(hasUpdate("0.4.0", "0.4.0")).toBe(false);
  });
});
