import { test, expect, describe } from "vitest";
import {
  isMeasurable, isPlausible, rememberDims, recallDims, MIN_COLS, MIN_ROWS,
} from "./fit-guard";

/** 一个够用的 Storage 替身：不碰真实 localStorage，测试之间互不串味。 */
function memStore(seed: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(seed));
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k: string) => m.get(k) ?? null,
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => { m.delete(k); },
    setItem: (k: string, v: string) => { m.set(k, v); },
  } as Storage;
}

/** 会抛的 Storage：模拟隐私模式。 */
function throwingStore(): Storage {
  return {
    get length() { return 0; },
    clear() { throw new Error("nope"); },
    getItem() { throw new Error("nope"); },
    key() { throw new Error("nope"); },
    removeItem() { throw new Error("nope"); },
    setItem() { throw new Error("nope"); },
  } as unknown as Storage;
}

describe("isMeasurable", () => {
  test("布局中的元素可测量", () => {
    expect(isMeasurable({ clientWidth: 390, clientHeight: 500 })).toBe(true);
  });

  // 这是本 bug 的核心形态：display:none 的元素 clientWidth/Height 都是 0。
  test("display:none 的元素（clientWidth/Height 皆 0）不可测量", () => {
    expect(isMeasurable({ clientWidth: 0, clientHeight: 0 })).toBe(false);
  });

  test("只有宽度塌陷、或只有高度塌陷，同样不可测量", () => {
    expect(isMeasurable({ clientWidth: 0, clientHeight: 500 })).toBe(false);
    expect(isMeasurable({ clientWidth: 390, clientHeight: 0 })).toBe(false);
  });

  test("null / undefined / 缺字段不抛，判为不可测量", () => {
    expect(isMeasurable(null)).toBe(false);
    expect(isMeasurable(undefined)).toBe(false);
    expect(isMeasurable({})).toBe(false);
  });
});

describe("isPlausible", () => {
  test("正常手机竖屏尺寸可信", () => {
    expect(isPlausible({ cols: 41, rows: 29 })).toBe(true);
  });

  // 真机实测到的塌陷值就落在这一档（parseInt("100%") === 100 推导出来的）。
  test("实测塌陷值 9x5 / 12x5 判为不可信", () => {
    expect(isPlausible({ cols: 9, rows: 5 })).toBe(false);
    expect(isPlausible({ cols: 12, rows: 5 })).toBe(false);
  });

  test("边界：恰好等于下限算可信，差一个算不可信", () => {
    expect(isPlausible({ cols: MIN_COLS, rows: MIN_ROWS })).toBe(true);
    expect(isPlausible({ cols: MIN_COLS - 1, rows: MIN_ROWS })).toBe(false);
    expect(isPlausible({ cols: MIN_COLS, rows: MIN_ROWS - 1 })).toBe(false);
  });

  test("NaN / Infinity / 负数 / 空值都不可信", () => {
    expect(isPlausible({ cols: NaN, rows: 29 })).toBe(false);
    expect(isPlausible({ cols: 41, rows: NaN })).toBe(false);
    expect(isPlausible({ cols: Infinity, rows: 29 })).toBe(false);
    expect(isPlausible({ cols: -41, rows: 29 })).toBe(false);
    expect(isPlausible(null)).toBe(false);
    expect(isPlausible(undefined)).toBe(false);
  });
});

describe("兜底尺寸的记忆与取回", () => {
  test("记住可信尺寸后能原样取回", () => {
    const s = memStore();
    rememberDims({ cols: 41, rows: 29 }, s);
    expect(recallDims(s)).toEqual({ cols: 41, rows: 29 });
  });

  // 兜底不被污染是整个方案成立的前提：记住塌陷值等于把一次性故障变成永久故障。
  test("塌陷尺寸绝不被记住", () => {
    const s = memStore();
    rememberDims({ cols: 41, rows: 29 }, s);
    rememberDims({ cols: 9, rows: 5 }, s);
    expect(recallDims(s)).toEqual({ cols: 41, rows: 29 });
  });

  test("从未记过则返回 null", () => {
    expect(recallDims(memStore())).toBeNull();
  });

  test("localStorage 里的脏数据一律判为无兜底，而不是照单全收", () => {
    expect(recallDims(memStore({ "pocketshell.lastGoodDims": "not json" }))).toBeNull();
    expect(recallDims(memStore({ "pocketshell.lastGoodDims": "null" }))).toBeNull();
    expect(recallDims(memStore({ "pocketshell.lastGoodDims": '"41x29"' }))).toBeNull();
    expect(recallDims(memStore({ "pocketshell.lastGoodDims": "{}" }))).toBeNull();
    // 别人（或旧版本）写进去的塌陷值同样不能信。
    expect(recallDims(memStore({ "pocketshell.lastGoodDims": '{"cols":9,"rows":5}' }))).toBeNull();
  });

  test("隐私模式下 Storage 抛异常时，读写都不炸", () => {
    expect(() => rememberDims({ cols: 41, rows: 29 }, throwingStore())).not.toThrow();
    expect(recallDims(throwingStore())).toBeNull();
  });
});
