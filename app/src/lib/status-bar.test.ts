import { describe, it, expect } from "vitest";
import { formatContext } from "./status-bar";

describe("formatContext", () => {
  it("已用与总量齐全时给出 已用/总量 · 百分比", () => {
    expect(formatContext(142000, 1000000)).toBe("142k/1M · 14%");
    expect(formatContext(63476, 262144)).toBe("63k/262k · 24%");
  });

  it("只有已用时不编造分母", () => {
    expect(formatContext(142000, undefined)).toBe("142k");
    expect(formatContext(500)).toBe("500");
  });

  it("缺已用时整块隐藏（沿用「数据缺失即隐藏」规则）", () => {
    expect(formatContext(undefined, 200000)).toBe("");
    expect(formatContext(undefined, undefined)).toBe("");
  });

  it("千位以下原样显示", () => {
    expect(formatContext(999, 200000)).toBe("999/200k · 0%");
  });

  it("百万级用 M，带一位小数（整数则不带）", () => {
    expect(formatContext(1500000, 2000000)).toBe("1.5M/2M · 75%");
  });

  it("百分比取整", () => {
    expect(formatContext(1, 3)).toBe("1/3 · 33%");
    expect(formatContext(2, 3)).toBe("2/3 · 67%");
  });

  it("总量为 0 时不算百分比（防除零）", () => {
    expect(formatContext(100, 0)).toBe("100");
  });

  it("非有限值一律视为缺失", () => {
    expect(formatContext(NaN, 100)).toBe("");
    expect(formatContext(100, NaN)).toBe("100");
    expect(formatContext(Infinity, 100)).toBe("");
  });

  it("负数视为缺失", () => {
    expect(formatContext(-5, 100)).toBe("");
  });
});
