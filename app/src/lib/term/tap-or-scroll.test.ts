import { test, expect } from "vitest";
import { isTap } from "./tap-or-scroll";

test("原地按下抬手是点击", () => {
  expect(isTap({ x: 100, y: 50 }, { x: 100, y: 50 })).toBe(true);
});

test("阈值内的微小抖动仍算点击", () => {
  expect(isTap({ x: 100, y: 50 }, { x: 106, y: 50 })).toBe(true);
});

test("横向拖过阈值判为滚动", () => {
  expect(isTap({ x: 100, y: 50 }, { x: 140, y: 50 })).toBe(false);
});

test("斜向拖动也判为滚动——只看 dx 会把它误判成点击", () => {
  // dx=8 未过阈，但 dy=8，合成位移 11.3 > 10
  expect(isTap({ x: 100, y: 50 }, { x: 108, y: 58 })).toBe(false);
});

test("恰好等于阈值算点击（边界含等号）", () => {
  expect(isTap({ x: 100, y: 50 }, { x: 110, y: 50 })).toBe(true);
});

test("阈值可覆盖", () => {
  expect(isTap({ x: 100, y: 50 }, { x: 115, y: 50 }, 20)).toBe(true);
  expect(isTap({ x: 100, y: 50 }, { x: 115, y: 50 }, 5)).toBe(false);
});

// jsdom 没有原生 PointerEvent，合成事件常缺 clientX/Y。缺失当 0 处理：
// 若让 undefined 流进减法，NaN 参与的比较恒为 false，整条判定会被静默废掉。
test("坐标缺失按 0 处理，起止都缺时判为点击", () => {
  expect(isTap({}, {})).toBe(true);
});

test("一端缺坐标时按 0 参与计算", () => {
  expect(isTap({}, { x: 40, y: 0 })).toBe(false);
});
