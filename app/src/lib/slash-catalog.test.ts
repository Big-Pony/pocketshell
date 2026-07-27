import { describe, it, test, expect } from "vitest";
import { SLASH_CATALOG, suggestSlash } from "./slash-catalog";

describe("slash catalog", () => {
  it("prefix-matches and keeps catalog (core-first) order", () => {
    // "/c" hits several; core-tier entries must come before secondary ones.
    const r = suggestSlash("/c", []);
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
    expect(suggestSlash("/CO", [])).toContain("/compact");
  });
  it("drops the entry equal to the input", () => {
    expect(suggestSlash("/model", [])).not.toContain("/model");
  });
  it("empty or non-slash input yields nothing meaningful here", () => {
    // suggestSlash is only called when the line starts with '/'; a bare '/'
    // returns the whole catalog.
    expect(suggestSlash("/", []).length).toBe(SLASH_CATALOG.length);
  });
});

test("自定义 slash 排在内置之前", () => {
  const out = suggestSlash("/re", ["/refactor"]);
  expect(out[0]).toBe("/refactor");
  expect(out).toContain("/review");
});

test("自定义与内置重复时不出现两个相同条目", () => {
  const out = suggestSlash("/cl", ["/clear"]);
  expect(out.filter((x) => x === "/clear")).toHaveLength(1);
});

test("自定义中等于当前输入的条目被排除", () => {
  expect(suggestSlash("/clear", ["/clear"])).not.toContain("/clear");
});
