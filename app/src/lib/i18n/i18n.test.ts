// app/src/lib/i18n/i18n.test.ts
// Guards against dictionary drift: zh and en must expose exactly the same set
// of leaf keys, so a string added in one language can't silently fall back
// (or render the raw key) in the other.
import { test, expect } from "vitest";
import zh from "./zh";
import en from "./en";
import { FONTS } from "../font";

function leafKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") out.push(...leafKeys(v as Record<string, unknown>, path));
    else out.push(path);
  }
  return out.sort();
}

test("zh and en dictionaries have identical key sets", () => {
  const zhKeys = leafKeys(zh as Record<string, unknown>);
  const enKeys = leafKeys(en as Record<string, unknown>);
  expect(zhKeys).toEqual(enKeys);
});

test("no dictionary value is empty", () => {
  for (const dict of [zh, en] as Record<string, unknown>[]) {
    for (const key of leafKeys(dict)) {
      const v = key.split(".").reduce<unknown>((o, p) => (o as Record<string, unknown>)[p], dict);
      expect(typeof v).toBe("string");
      expect((v as string).length).toBeGreaterThan(0);
    }
  }
});

test("每套字体都有中英文名字词条", () => {
  // 漏一条的症状不是报错，是设置面板里那一行直接显示 "settings.font.xxx"。
  for (const f of FONTS) {
    expect(zh.settings.font[f.id], `zh 缺 settings.font.${f.id}`).toBeTruthy();
    expect(en.settings.font[f.id], `en 缺 settings.font.${f.id}`).toBeTruthy();
  }
});

test("zh and en use the same {placeholder} names per key", () => {
  const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const key of leafKeys(zh as Record<string, unknown>)) {
    const pick = (d: unknown) => key.split(".").reduce<unknown>((o, p) => (o as Record<string, unknown>)[p], d) as string;
    expect(ph(pick(en)), `placeholder mismatch at ${key}`).toEqual(ph(pick(zh)));
  }
});

// 14 期需求 5：App.svelte 整体渲染开销大（xterm + 全部面板），故这里只焊住
// 文案分支的前提——两条 key 都在且措辞不同。真机走查确认它挂在 everOnline 上。
test("首次连接与断线重连用两句不同的横幅文案", () => {
  for (const [name, dict] of [["zh", zh], ["en", en]] as const) {
    const app = (dict as any).app;
    expect(app.bannerFirstConnect, `${name} 缺 app.bannerFirstConnect`).toBeTruthy();
    expect(app.banner, `${name} 的首连文案与重连文案相同`).not.toBe(app.bannerFirstConnect);
    // 首连场景下不该出现"断开/Disconnected"——那正是这次要修的语义错位。
    expect(app.bannerFirstConnect).not.toMatch(/断开|Disconnected/);
  }
});
