import { test, expect, vi, beforeEach } from "vitest";
import {
  FONTS, DEFAULT_FONT, applyFont, initFont, familyOf, termFontFamily,
} from "./font";
import { loadSettings, saveSettings, DEFAULT_SETTINGS } from "./settings";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-font");
});

test("FONTS 覆盖 5 套且 id 互不相同", () => {
  expect(FONTS).toHaveLength(5);
  expect(new Set(FONTS.map((f) => f.id)).size).toBe(5);
});

test("默认字体在清单里，且与 settings 的默认一致", () => {
  // 对不上就是首帧渲染 A 字体、applyFont 之后换成 B，用户看到跳一下。
  expect(FONTS.some((f) => f.id === DEFAULT_FONT)).toBe(true);
  expect(DEFAULT_SETTINGS.fontFamily).toBe(DEFAULT_FONT);
});

test("每套字体的 url 指向 regular 权重的 woff2", () => {
  // 这个 url 会被写进 localStorage 供首帧 preload 用。preload 只预取 Regular，
  // Bold 保持惰性（与改造前 index.html 的注释一致）。
  for (const f of FONTS) {
    expect(f.url, `${f.id} 的 url 不是 regular`).toMatch(/^\/fonts\/.*-regular\.woff2$|JetBrainsMono-Regular\.woff2$/);
  }
});

test("applyFont 写 data-font 属性", () => {
  applyFont("nord" as never); // 不在清单里的值不该被写进去
  expect(document.documentElement.dataset.font).toBe(DEFAULT_FONT);

  applyFont("ubuntu-mono");
  expect(document.documentElement.dataset.font).toBe("ubuntu-mono");
});

test("applyFont 把 preload 路径存回设置，供下次首帧用", () => {
  applyFont("monaspace-neon");
  expect(loadSettings().bootFontUrl).toBe("/fonts/monaspace-neon-regular.woff2");
});

test("applyFont 在 localStorage 抛错时不炸", () => {
  // 隐私模式下 setItem 会抛。换字体这个动作不该因为存不下缓存值而整个失败。
  const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("QuotaExceeded");
  });
  expect(() => applyFont("ubuntu-mono")).not.toThrow();
  expect(document.documentElement.dataset.font).toBe("ubuntu-mono");
  spy.mockRestore();
});

test("familyOf 返回单个家族名，不是回落链", () => {
  // document.fonts.load() 要的是一个 family，喂整条链会静默什么都不加载。
  expect(familyOf("maple-mono")).toBe("Maple Mono NF");
  expect(familyOf("monaspace-neon")).toBe("MonaspiceNe NFM");
  expect(familyOf("maple-mono")).not.toContain(",");
});

test("Monaspace 用的是 NF 改名后的家族名 —— Reserved Font Name 合规", () => {
  // 上游 NF 版把 Monaspace 改名成 MonaspiceNe 正是为了避开保留名。
  // 写回 "Monaspace Neon" 既违反 OFL，也会因内部名对不上而根本加载不到。
  const mona = FONTS.find((f) => f.id === "monaspace-neon")!;
  expect(mona.family).toBe("MonaspiceNe NFM");
  expect(mona.family).not.toContain("Monaspace");
});

test("initFont 应用已存的偏好", () => {
  saveSettings({ ...DEFAULT_SETTINGS, fontFamily: "google-sans-code" });
  expect(initFont()).toBe("google-sans-code");
  expect(document.documentElement.dataset.font).toBe("google-sans-code");
});

test("initFont 在没有存过偏好时用默认", () => {
  expect(initFont()).toBe(DEFAULT_FONT);
});

test("termFontFamily 在 jsdom 下返回回落链而不是空串", () => {
  // jsdom 不注入 CSS，getComputedStyle 读 --font-mono 只会拿到空串。
  // 返回空串会让 xterm 用它自己的默认字体（等宽但不是我们这套），
  // 而且这个 bug 在真机上看不出来——必须在这里挡住。
  applyFont("ubuntu-mono");
  const chain = termFontFamily();
  expect(chain).not.toBe("");
  expect(chain).toContain("UbuntuMono Nerd Font Mono");
  expect(chain).toContain("monospace");
});
