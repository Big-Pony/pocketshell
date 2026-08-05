import { test, expect, describe } from "bun:test";
import { isSaneSize, MIN_COLS, MIN_ROWS, MAX_COLS, MAX_ROWS } from "./sane-size";

describe("isSaneSize", () => {
  test("真实设备尺寸通过", () => {
    expect(isSaneSize(41, 29)).toBe(true);   // 手机竖屏
    expect(isSaneSize(61, 27)).toBe(true);   // 真机日志里的实际值
    expect(isSaneSize(80, 24)).toBe(true);   // agent 默认
    expect(isSaneSize(200, 60)).toBe(true);  // 桌面宽屏
  });

  // 真机实测到的塌陷值。这是本模块存在的唯一理由。
  test("塌陷尺寸被拒", () => {
    expect(isSaneSize(9, 5)).toBe(false);
    expect(isSaneSize(12, 5)).toBe(false);
    expect(isSaneSize(2, 1)).toBe(false);  // FitAddon 的 MINIMUM_COLS/ROWS
  });

  test("边界：等于下限通过，差一个被拒", () => {
    expect(isSaneSize(MIN_COLS, MIN_ROWS)).toBe(true);
    expect(isSaneSize(MIN_COLS - 1, MIN_ROWS)).toBe(false);
    expect(isSaneSize(MIN_COLS, MIN_ROWS - 1)).toBe(false);
  });

  test("边界：等于上限通过，超一个被拒", () => {
    expect(isSaneSize(MAX_COLS, MAX_ROWS)).toBe(true);
    expect(isSaneSize(MAX_COLS + 1, MAX_ROWS)).toBe(false);
    expect(isSaneSize(MAX_COLS, MAX_ROWS + 1)).toBe(false);
  });

  test("非整数、非有限值、负数被拒", () => {
    expect(isSaneSize(41.5, 29)).toBe(false);
    expect(isSaneSize(NaN, 29)).toBe(false);
    expect(isSaneSize(Infinity, 29)).toBe(false);
    expect(isSaneSize(-41, 29)).toBe(false);
    expect(isSaneSize(0, 0)).toBe(false);
  });

  // 协议帧是外部输入，类型注解拦不住运行时的脏数据。
  test("非数字类型被拒而不是抛", () => {
    expect(isSaneSize("41", "29")).toBe(false);
    expect(isSaneSize(null, null)).toBe(false);
    expect(isSaneSize(undefined, undefined)).toBe(false);
    expect(isSaneSize({}, [])).toBe(false);
  });
});
