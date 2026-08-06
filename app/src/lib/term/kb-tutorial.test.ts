import { test, expect } from "vitest";
import { tutorialFor, shouldShowTutorial, markTutorialSeen, resetTutorial } from "./kb-tutorial";

function memStore(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  } as Storage;
}

test("classic 没有教程 —— 它没有需要学的新概念", () => {
  expect(tutorialFor("classic")).toBeNull();
  expect(shouldShowTutorial("classic", memStore())).toBe(false);
});

test("layered / flick 各有自己的教程", () => {
  expect(tutorialFor("layered")).toBe("layered");
  expect(tutorialFor("flick")).toBe("flick");
});

test("首次切到新布局要弹，标记后不再弹", () => {
  const store = memStore();
  expect(shouldShowTutorial("layered", store)).toBe(true);
  markTutorialSeen("layered", store);
  expect(shouldShowTutorial("layered", store)).toBe(false);
});

test("两套教程的标记互相独立 —— 看过分层不该让上滑不弹", () => {
  const store = memStore();
  markTutorialSeen("layered", store);
  expect(shouldShowTutorial("layered", store)).toBe(false);
  expect(shouldShowTutorial("flick", store)).toBe(true);
});

test("reset 后能再弹一次（设置里的「重看教程」）", () => {
  const store = memStore();
  markTutorialSeen("flick", store);
  resetTutorial("flick", store);
  expect(shouldShowTutorial("flick", store)).toBe(true);
});

test("标记 classic 是安全的空操作，不写任何键", () => {
  const store = memStore();
  markTutorialSeen("classic", store);
  resetTutorial("classic", store);
  expect(store.length).toBe(0);
});

test("Storage 抛异常（隐私模式/配额满）时降级为「不弹」，不能把键盘搞崩", () => {
  const boom = {
    getItem() { throw new Error("denied"); },
    setItem() { throw new Error("denied"); },
    removeItem() { throw new Error("denied"); },
  } as unknown as Storage;
  expect(() => shouldShowTutorial("flick", boom)).not.toThrow();
  expect(shouldShowTutorial("flick", boom)).toBe(false);
  expect(() => markTutorialSeen("flick", boom)).not.toThrow();
});
