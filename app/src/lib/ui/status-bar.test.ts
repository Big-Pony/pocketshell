import { describe, it, test, expect } from "vitest";
import { formatContext, formatLatency, formatRate, formatBranch, BRANCH_MAX } from "./status-bar";

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

// ---- formatLatency ----
test("formatLatency rounds normal values to whole ms", () => {
  expect(formatLatency(42)).toBe("42ms");
  expect(formatLatency(42.4)).toBe("42ms");
  expect(formatLatency(42.6)).toBe("43ms");
});
test("formatLatency collapses sub-millisecond to <1ms", () => {
  expect(formatLatency(0)).toBe("<1ms");
  expect(formatLatency(0.4)).toBe("<1ms");
});
test("formatLatency caps at 999ms+ so the bar can't widen without bound", () => {
  expect(formatLatency(999)).toBe("999ms+");
  expect(formatLatency(4000)).toBe("999ms+");
});
test("formatLatency renders missing/invalid samples as empty, not a placeholder", () => {
  expect(formatLatency(null)).toBe("");
  expect(formatLatency(-1)).toBe("");
  expect(formatLatency(NaN)).toBe("");
  expect(formatLatency(Infinity)).toBe("");
});

// ---- formatRate ----
test("formatRate converts to KB/s for the common case", () => {
  expect(formatRate(12 * 1024, 1000)).toBe("12KB/s");
  // half-second window doubles the rate
  expect(formatRate(6 * 1024, 500)).toBe("12KB/s");
});
test("formatRate switches to MB/s at 1MB and keeps one decimal", () => {
  expect(formatRate(1024 * 1024, 1000)).toBe("1.0MB/s");
  expect(formatRate(1.25 * 1024 * 1024, 1000)).toBe("1.3MB/s");
});
test("formatRate gives one decimal below 1KB/s so small traffic is still visible", () => {
  expect(formatRate(920, 1000)).toBe("0.9KB/s");
});
test("formatRate shows 0KB/s when idle — constant width prevents layout jitter", () => {
  expect(formatRate(0, 1000)).toBe("0KB/s");
});
test("formatRate guards against divide-by-zero windows", () => {
  expect(formatRate(1024, 0)).toBe("");
  expect(formatRate(1024, -5)).toBe("");
  expect(formatRate(NaN, 1000)).toBe("");
});

// ---- formatBranch ----
test("formatBranch passes short names through and marks dirty with *", () => {
  expect(formatBranch("main")).toBe("main");
  expect(formatBranch("main", true)).toBe("main*");
});
test("formatBranch truncates long names keeping the tail", () => {
  const out = formatBranch("feature/very-long-branch-name");
  expect(out.length).toBeLessThanOrEqual(BRANCH_MAX);
  expect(out.startsWith("…")).toBe(true);
  expect(out.endsWith("branch-name")).toBe(true);
});
test("formatBranch keeps the dirty marker within the length budget", () => {
  const out = formatBranch("feature/very-long-branch-name", true);
  expect(out.length).toBeLessThanOrEqual(BRANCH_MAX);
  expect(out.endsWith("*")).toBe(true);
});
test("formatBranch renders no branch as empty so the group hides entirely", () => {
  expect(formatBranch("")).toBe("");
  expect(formatBranch("   ")).toBe("");
});

test("formatRate rounds heartbeat-only traffic down to a clean 0KB/s", () => {
  // 心跳帧本身几十字节，摊到 10s 窗口约 0.005KB/s。空闲时该显示干净的
  // 0KB/s，而不是一个永远挂着的 0.0KB/s。
  expect(formatRate(60, 10_000)).toBe("0KB/s");
  // 但真有小流量时仍然看得见
  expect(formatRate(600, 10_000)).toBe("0.1KB/s");
});
