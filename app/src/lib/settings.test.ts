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
  saveSettings({ layout: "win", kbLayout: "layered", fontSize: 14, vibrate: "off", theme: "cream-light", language: "en", groupTabsByType: false, fontFamily: "ubuntu-mono" }, store);
  expect(loadSettings(store)).toEqual({ layout: "win", kbLayout: "layered", fontSize: 14, vibrate: "off", theme: "cream-light", language: "en", groupTabsByType: false, fontFamily: "ubuntu-mono" });
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

test("loadSettings 放行 custom: 前缀的任意合法 id", () => {
  // 有哪些自定义主题只有 agent 知道（用户往 keyDir 里丢 .ghostty），
  // 前端没法预先列举，只能按前缀放行。id 是文件名 slug 化的产物（小写 kebab）。
  for (const id of ["custom:paper", "custom:tokyo-night", "custom:3024-day", "custom:theme-1a2b3c4d"]) {
    const store = memStore();
    store.setItem("ps.settings", JSON.stringify({ theme: id }));
    expect(loadSettings(store).theme, id).toBe(id);
  }
});

test("loadSettings 把 slug 化之前存下的旧 custom id 当成失效值回落", () => {
  // 2026-08-05 之前 id 就是文件名（`custom:My_Theme`）。改成 slug 之后那种 id
  // 在 CSS 里已经不存在，与「文件被改名/删了」是同一种结局：回落默认，
  // 用户在设置里重选一次。不做迁移映射——旧 id 到新 id 不是一一对应的。
  for (const id of ["custom:My_Theme", "custom:gruvbox.2", "custom:Tokyo Night"]) {
    const store = memStore();
    store.setItem("ps.settings", JSON.stringify({ theme: id }));
    expect(loadSettings(store).theme, id).toBe("cream-dark");
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
  for (const v of ["", "   ", 42, null, "#fff; }", "url(javascript:alert(1))", "x".repeat(70)]) {
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

test("fontFamily 默认 maple-mono，脏数据回落默认", () => {
  localStorage.setItem("ps.settings", JSON.stringify({ fontFamily: "comic-sans" }));
  expect(loadSettings().fontFamily).toBe("maple-mono");

  localStorage.setItem("ps.settings", JSON.stringify({ fontFamily: "ubuntu-mono" }));
  expect(loadSettings().fontFamily).toBe("ubuntu-mono");
});

test("老用户没有 fontFamily 字段时回落默认（升级路径）", () => {
  // 1.10.0 及以前存下来的设置里没有这个字段。回落到新默认是有意为之，
  // release notes 里要写明怎么改回 JetBrains Mono。
  localStorage.setItem("ps.settings", JSON.stringify({ theme: "nord", fontSize: 12 }));
  const s = loadSettings();
  expect(s.fontFamily).toBe("maple-mono");
  expect(s.theme).toBe("nord"); // 其余字段不受影响
});

test("bootFontUrl 收得下最长的字体路径", () => {
  // coerceBootValue 原来上限 32，装不下 /fonts/google-sans-code-regular.woff2。
  const url = "/fonts/google-sans-code-regular.woff2";
  localStorage.setItem("ps.settings", JSON.stringify({ bootFontUrl: url }));
  expect(loadSettings().bootFontUrl).toBe(url);
});

test("bootFontUrl 拒绝可疑值", () => {
  localStorage.setItem("ps.settings", JSON.stringify({ bootFontUrl: '"><script>' }));
  expect(loadSettings().bootFontUrl).toBeUndefined();
});

test("bootFontUrl 只放行本地 /fonts/*.woff2 路径，拒绝协议相对/跨域/穿越", () => {
  // 宽松字符集能放过 `//evil.com/x.woff2`（协议相对 URL 不需要冒号），内联脚本
  // 会把它原样塞进 <link href>，首帧就发出一个跨域请求。
  for (const bad of ["//evil.com/a.woff2", "https://evil.com/a.woff2", "/fonts/../../etc/passwd"]) {
    localStorage.setItem("ps.settings", JSON.stringify({ bootFontUrl: bad }));
    expect(loadSettings().bootFontUrl, bad).toBeUndefined();
  }
  for (const good of ["/fonts/maple-mono-regular.woff2", "/fonts/JetBrainsMono-Regular.woff2"]) {
    localStorage.setItem("ps.settings", JSON.stringify({ bootFontUrl: good }));
    expect(loadSettings().bootFontUrl, good).toBe(good);
  }
});

test("kbLayout 默认 classic —— 老用户升级手感不变", () => {
  expect(DEFAULT_SETTINGS.kbLayout).toBe("classic");
});

test("kbLayout 读得回三个合法值", () => {
  for (const id of ["classic", "layered", "flick"] as const) {
    const store = memStore();
    store.setItem("ps.settings", JSON.stringify({ kbLayout: id }));
    expect(loadSettings(store).kbLayout).toBe(id);
  }
});

test("kbLayout 脏值回落 classic（id 会拼进 CSS 选择器，脏值只会静默失配）", () => {
  for (const bad of ["swipe", "", null, 42, { a: 1 }]) {
    const store = memStore();
    store.setItem("ps.settings", JSON.stringify({ kbLayout: bad }));
    expect(loadSettings(store).kbLayout).toBe("classic");
  }
});

test("旧版本存档没有 kbLayout 字段时也回落 classic", () => {
  const store = memStore();
  store.setItem("ps.settings", JSON.stringify({ theme: "nord", fontSize: 12 }));
  expect(loadSettings(store).kbLayout).toBe("classic");
});
