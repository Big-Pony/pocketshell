import { describe, it, expect } from "vitest";
import { SLASH_CATALOG, suggestSlash } from "./slash-catalog";

describe("slash catalog", () => {
  it("prefix-matches and keeps catalog (core-first) order", () => {
    // "/c" hits several; core-tier entries must come before secondary ones.
    const r = suggestSlash("/c");
    expect(r).toContain("/clear");
    expect(r).toContain("/compact");
    expect(r).toContain("/context");
    expect(r).toContain("/cost");
    expect(r).toContain("/copy");
    expect(r).toContain("/config");
    // core (/clear /compact /context /cost) precede secondary (/copy /config)
    expect(r.indexOf("/cost")).toBeLessThan(r.indexOf("/copy"));
    expect(r.indexOf("/cost")).toBeLessThan(r.indexOf("/config"));
  });
  it("is case-insensitive", () => {
    expect(suggestSlash("/CO")).toContain("/compact");
  });
  it("drops the entry equal to the input", () => {
    expect(suggestSlash("/model")).not.toContain("/model");
  });
  it("empty or non-slash input yields nothing meaningful here", () => {
    // suggestSlash is only called when the line starts with '/'; a bare '/'
    // returns the whole catalog.
    expect(suggestSlash("/").length).toBe(SLASH_CATALOG.length);
  });
});
