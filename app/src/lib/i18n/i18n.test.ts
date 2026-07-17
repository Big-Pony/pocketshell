// app/src/lib/i18n/i18n.test.ts
// Guards against dictionary drift: zh and en must expose exactly the same set
// of leaf keys, so a string added in one language can't silently fall back
// (or render the raw key) in the other.
import { test, expect } from "vitest";
import zh from "./zh";
import en from "./en";

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

test("zh and en use the same {placeholder} names per key", () => {
  const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const key of leafKeys(zh as Record<string, unknown>)) {
    const pick = (d: unknown) => key.split(".").reduce<unknown>((o, p) => (o as Record<string, unknown>)[p], d) as string;
    expect(ph(pick(en)), `placeholder mismatch at ${key}`).toEqual(ph(pick(zh)));
  }
});
