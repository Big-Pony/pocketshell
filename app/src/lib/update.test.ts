import { describe, it, expect } from "vitest";
import { phaseLabelKey, hasUpdate, compareSemver, shouldReloadAfterUpdate } from "./update";

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

describe("shouldReloadAfterUpdate", () => {
  it("reloads when an update was in flight and the agent moved to a new version", () => {
    expect(shouldReloadAfterUpdate("1.0.1", "1.0.2", "restarting")).toBe(true);
  });

  it("does not reload when the version did not move (supervisor rolled back)", () => {
    expect(shouldReloadAfterUpdate("1.0.1", "1.0.1", "restarting")).toBe(false);
  });

  it("does not reload on a plain reconnect with no update in flight", () => {
    expect(shouldReloadAfterUpdate("1.0.1", "1.0.2", null)).toBe(false);
  });

  it("does not reload when the agent version is unknown", () => {
    expect(shouldReloadAfterUpdate("1.0.1", "", "restarting")).toBe(false);
  });
});
