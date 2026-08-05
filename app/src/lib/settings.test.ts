// app/src/lib/settings.test.ts
import { test, expect } from "vitest";
import { DEFAULT_SETTINGS, THEMES, loadSettings, saveSettings, detectLanguage, type Settings } from "./settings";

function memStore(): Storage {
  const data = new Map<string, string>();
  return {
    getItem(k: string) { return data.get(k) ?? null; },
    setItem(k: string, v: string) { data.set(k, v); },
    removeItem(k: string) { data.delete(k); },
    get length() { return data.size; },
    key(_i: number) { return null; },
    clear() { data.clear(); },
  };
}

test("loadSettings returns defaults when nothing stored", () => {
  // language follows the browser on first run (jsdom is en-US -> en)
  expect(loadSettings(memStore())).toEqual({ ...DEFAULT_SETTINGS, language: detectLanguage() });
});

test("saveSettings persists and loadSettings reads back", () => {
  const store = memStore();
  saveSettings({ layout: "win", fontSize: 14, vibrate: "off", theme: "cream-light", language: "en", groupTabsByType: false }, store);
  expect(loadSettings(store)).toEqual({ layout: "win", fontSize: 14, vibrate: "off", theme: "cream-light", language: "en", groupTabsByType: false });
});

test("loadSettings fills missing keys with defaults", () => {
  const store = memStore();
  store.setItem("ps.settings", JSON.stringify({ vibrate: "off" }));
  const s = loadSettings(store);
  expect(s.vibrate).toBe("off");
  expect(s.layout).toBe("mac");       // default
  expect(s.fontSize).toBe(10);        // default
  expect(s.theme).toBe("cream-dark"); // default
  expect(s.language).toBe(detectLanguage()); // missing -> browser detection
});

test("default theme is cream-dark", () => {
  // 必须与 theme-tokens.css 里渲染为无属性 :root 的那套一致，否则首帧
  // （还没写 data-theme 时）拿到的是 A 套令牌、脚本随后又切到 B 套。
  expect(DEFAULT_SETTINGS.theme).toBe("cream-dark");
});

test("loadSettings rejects unknown theme values", () => {
  const store = memStore();
  // 哨兵值刻意选一个不可能成为真主题名的字符串：用真实感的名字（曾经是 "neon"）
  // 一旦哪天真加了同名主题，这条用例会静默失效——依然是绿的，但不再测它想测的。
  store.setItem("ps.settings", JSON.stringify({ theme: "__not_a_theme__" }));
  expect(loadSettings(store).theme).toBe("cream-dark");
  expect(THEMES).not.toContain("__not_a_theme__");
});

test("loadSettings accepts every theme it advertises", () => {
  // 逐个走一遍 THEMES，新增主题时忘了同步白名单会被这里抓到
  // （症状是用户选了新主题、刷新后被打回默认）。
  for (const theme of THEMES) {
    const store = memStore();
    store.setItem("ps.settings", JSON.stringify({ theme }));
    expect(loadSettings(store).theme).toBe(theme);
  }
});

// ── 旧主题 id（2026-08-05 换 Ghostty 体系之前的六套）──

test("旧主题 id 一律回落新默认，不做迁移映射", () => {
  // 计划「已知取舍」：不写映射表。老用户换版后回到默认配色，自己再选一次。
  for (const legacy of ["dark", "light", "osc", "prussian", "vermilion"]) {
    const store = memStore();
    store.setItem("ps.settings", JSON.stringify({ theme: legacy }));
    expect(loadSettings(store).theme, `旧 id "${legacy}" 应回落默认`).toBe("cream-dark");
  }
});

test('"blackout" 同名不同义，会被保留（已知且可接受）', () => {
  // 旧 blackout 是「纯黑银」，新 blackout 是 Black Metal 改编。名字撞上了，
  // 于是老用户的这套偏好会**原样存活**而不是回落——两者都是纯黑 OLED 向，
  // 观感接近，故接受。这条用例固定该行为：哪天有人想改成「撞名也回落」，
  // 会先在这里翻车，而不是在用户那边悄悄换了配色。
  const store = memStore();
  store.setItem("ps.settings", JSON.stringify({ theme: "blackout" }));
  expect(loadSettings(store).theme).toBe("blackout");
});

// ── 自定义主题 id ──

test("loadSettings 放行 custom: 前缀的任意合法名字", () => {
  // 有哪些自定义主题只有 agent 知道（用户往 keyDir 里丢 .ghostty），
  // 前端没法预先列举，只能按前缀放行。
  for (const id of ["custom:paper", "custom:My_Theme", "custom:gruvbox.2"]) {
    const store = memStore();
    store.setItem("ps.settings", JSON.stringify({ theme: id }));
    expect(loadSettings(store).theme, id).toBe(id);
  }
});

test("loadSettings 拒绝会破坏 CSS 选择器的 custom: 名字", () => {
  // 这些字符拼进 [data-theme="…"] 不会报错，只会静默失配——主题看着没生效
  // 却查不出原因。挡在入口比事后排查便宜得多。
  const bad = [
    'custom:a"b', "custom:a'b", "custom:a\nb", "custom:a b",
    "custom:a]b", "custom:a{b}", "custom:a;b", "custom:../etc", "custom:",
  ];
  for (const id of bad) {
    const store = memStore();
    store.setItem("ps.settings", JSON.stringify({ theme: id }));
    expect(loadSettings(store).theme, JSON.stringify(id)).toBe("cream-dark");
  }
});

// ── 首帧缓存字段（index.html/demo.html 的内联脚本读它们）──

test("bootBg / scheme 默认不存在，写了能读回", () => {
  expect(loadSettings(memStore()).bootBg).toBeUndefined();
  expect(loadSettings(memStore()).scheme).toBeUndefined();
  const store = memStore();
  saveSettings({ ...DEFAULT_SETTINGS, bootBg: "#242524", scheme: "dark" }, store);
  expect(loadSettings(store).bootBg).toBe("#242524");
  expect(loadSettings(store).scheme).toBe("dark");
});

test("bootBg 脏值被丢弃（它会被直接写进 style.background）", () => {
  for (const v of ["", "   ", 42, null, "#fff; }", "url(javascript:alert(1))", "x".repeat(40)]) {
    const store = memStore();
    store.setItem("ps.settings", JSON.stringify({ bootBg: v }));
    expect(loadSettings(store).bootBg, JSON.stringify(v)).toBeUndefined();
  }
});

test("scheme 只收 dark / light", () => {
  const store = memStore();
  store.setItem("ps.settings", JSON.stringify({ scheme: "bright" }));
  expect(loadSettings(store).scheme).toBeUndefined();
});

test("default fontSize is 10", () => {
  expect(DEFAULT_SETTINGS.fontSize).toBe(10);
});

test("loadSettings falls back to 10 when stored fontSize is not a number", () => {
  const store = memStore();
  store.setItem("ps.settings", JSON.stringify({ fontSize: "big" }));
  expect(loadSettings(store).fontSize).toBe(10);
});

test("loadSettings keeps a valid stored language", () => {
  const store = memStore();
  store.setItem("ps.settings", JSON.stringify({ language: "zh" }));
  expect(loadSettings(store).language).toBe("zh");
});

test("loadSettings rejects unknown language values and re-detects", () => {
  const store = memStore();
  store.setItem("ps.settings", JSON.stringify({ language: "fr" }));
  expect(loadSettings(store).language).toBe(detectLanguage());
});

test("loadSettings migrates legacy boolean vibrate true -> medium", () => {
  const s = memStore();
  s.setItem("ps.settings", JSON.stringify({ layout: "mac", fontSize: 10, vibrate: true, theme: "dark", language: "zh" }));
  expect(loadSettings(s).vibrate).toBe("medium");
});

test("loadSettings migrates legacy boolean vibrate false -> off", () => {
  const s = memStore();
  s.setItem("ps.settings", JSON.stringify({ vibrate: false }));
  expect(loadSettings(s).vibrate).toBe("off");
});

test("loadSettings accepts a valid vibrate level and rejects garbage", () => {
  const s = memStore();
  s.setItem("ps.settings", JSON.stringify({ vibrate: "strong" }));
  expect(loadSettings(s).vibrate).toBe("strong");
  const s2 = memStore();
  s2.setItem("ps.settings", JSON.stringify({ vibrate: "loud" }));
  expect(loadSettings(s2).vibrate).toBe(DEFAULT_SETTINGS.vibrate);
});

test("detectLanguage follows navigator.language (zh* -> zh, else en)", () => {
  const desc = Object.getOwnPropertyDescriptor(Navigator.prototype, "language");
  const set = (v: string) => Object.defineProperty(Navigator.prototype, "language", { value: v, configurable: true });
  try {
    set("zh-CN");
    expect(detectLanguage()).toBe("zh");
    set("zh-TW");
    expect(detectLanguage()).toBe("zh");
    set("en-US");
    expect(detectLanguage()).toBe("en");
    set("fr-FR");
    expect(detectLanguage()).toBe("en");
  } finally {
    if (desc) Object.defineProperty(Navigator.prototype, "language", desc);
  }
});

test("groupTabsByType 默认为 false", () => {
  expect(loadSettings(memStore()).groupTabsByType).toBe(false);
});

test("groupTabsByType 可持久化并读回", () => {
  const store = memStore();
  saveSettings({ ...DEFAULT_SETTINGS, groupTabsByType: true }, store);
  expect(loadSettings(store).groupTabsByType).toBe(true);
});

test("groupTabsByType 非布尔脏数据回落 false", () => {
  const store = memStore();
  store.setItem("ps.settings", JSON.stringify({ groupTabsByType: "yes" }));
  expect(loadSettings(store).groupTabsByType).toBe(false);
});
