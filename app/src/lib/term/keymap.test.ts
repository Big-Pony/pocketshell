// app/src/lib/keymap.test.ts
import { test, expect } from "vitest";
import { SEQ, SHIFT_SYMBOLS, LAYOUT, FKEYS, ESC_KEY, MOD_IDS, capFor } from "./keymap";

test("arrow + esc + control sequences are the xterm defaults", () => {
  expect(SEQ.ArrowUp).toBe("\x1b[A");
  expect(SEQ.ArrowDown).toBe("\x1b[B");
  expect(SEQ.ArrowRight).toBe("\x1b[C");
  expect(SEQ.ArrowLeft).toBe("\x1b[D");
  expect(SEQ.Esc).toBe("\x1b");
  expect(SEQ.Tab).toBe("\x09");
  expect(SEQ.Enter).toBe("\r");
  expect(SEQ.Backspace).toBe("\x7f");
  expect(SEQ.Space).toBe(" ");
});

test("function-key sequences F1..F12", () => {
  expect(SEQ.F1).toBe("\x1bOP");
  expect(SEQ.F5).toBe("\x1b[15~");
  expect(SEQ.F12).toBe("\x1b[24~");
});

test("shift symbol map covers the number row", () => {
  expect(SHIFT_SYMBOLS["1"]).toBe("!");
  expect(SHIFT_SYMBOLS["-"]).toBe("_");
  expect(SHIFT_SYMBOLS["/"]).toBe("?");
  expect(SHIFT_SYMBOLS["`"]).toBe("~");
});

test("Esc and F-keys live outside LAYOUT for the smart hint bar", () => {
  expect(ESC_KEY).toEqual({ id: "Esc", cap: "Esc" });
  expect(FKEYS.length).toBe(12);
  expect(FKEYS[0]).toEqual({ id: "F1", cap: "F1" });
  expect(FKEYS[11]).toEqual({ id: "F12", cap: "F12" });
});

test("layout has 5 rows and modifiers are single (not duplicated)", () => {
  expect(LAYOUT.length).toBe(5);
  const ids = LAYOUT.flat().map((k) => k.id);
  for (const m of MOD_IDS) {
    expect(ids.filter((id) => id === m).length).toBeLessThanOrEqual(1);
  }
  // arrows all present on the bottom row, single row
  expect(ids.filter((id) => id.startsWith("Arrow")).sort()).toEqual(["ArrowDown","ArrowLeft","ArrowRight","ArrowUp"]);
});

test("capFor relabels the Cmd key per layout, leaves others unchanged", () => {
  expect(capFor({ id: "Cmd", cap: "Cmd" }, "mac")).toBe("Cmd");
  expect(capFor({ id: "Cmd", cap: "Cmd" }, "win")).toBe("Win");
  expect(capFor({ id: "a", cap: "A" }, "win")).toBe("A");
});

test("navigation keys map to escape sequences", () => {
  expect(SEQ.Home).toBe("\x1b[H");
  expect(SEQ.End).toBe("\x1b[F");
  expect(SEQ.PgUp).toBe("\x1b[5~");
  expect(SEQ.PgDn).toBe("\x1b[6~");
});

import {
  LAYOUT_LAYERED_ALPHA, LAYOUT_LAYERED_SYM, LAYOUT_FLICK,
  LAYOUT_BOTTOM_LAYERED, LAYOUT_BOTTOM_FLICK, LAYOUT_ARROWS, LAYER_KEY_ID,
} from "./keymap";

// 26 个字母一个不少、一个不重 —— 布局表是手写的，漏一个键用户就永远打不出那个字母。
function lettersOf(rows: { id: string }[][]): string[] {
  return rows.flat().map((k) => k.id).filter((id) => /^[a-z]$/.test(id)).sort();
}
const ALL_LETTERS = "abcdefghijklmnopqrstuvwxyz".split("");

test("layered 字母层含全部 26 字母，每行不超过 10 键", () => {
  expect(lettersOf(LAYOUT_LAYERED_ALPHA)).toEqual(ALL_LETTERS);
  for (const row of LAYOUT_LAYERED_ALPHA) expect(row.length).toBeLessThanOrEqual(10);
});

test("flick 含全部 26 字母，每行不超过 10 键", () => {
  expect(lettersOf(LAYOUT_FLICK)).toEqual(ALL_LETTERS);
  for (const row of LAYOUT_FLICK) expect(row.length).toBeLessThanOrEqual(10);
});

test("flick 的字母键都带 up（上滑字符），且 1-0 十个数字都能滑出来", () => {
  const withUp = LAYOUT_FLICK.flat().filter((k) => /^[a-z]$/.test(k.id));
  for (const k of withUp) expect(k.up, `字母 ${k.id} 缺 up`).toBeTruthy();
  const ups = withUp.map((k) => k.up);
  for (const d of "1234567890") expect(ups, `数字 ${d} 滑不出来`).toContain(d);
});

test("flick 的 up 映射无重复 —— 同一个字符挂两个键，用户学不会该滑哪个", () => {
  const ups = LAYOUT_FLICK.flat().map((k) => k.up).filter(Boolean);
  expect(new Set(ups).size).toBe(ups.length);
});

test("layered 符号层三行，且不含字母（字母在另一层）", () => {
  expect(LAYOUT_LAYERED_SYM.length).toBe(3);
  expect(lettersOf(LAYOUT_LAYERED_SYM)).toEqual([]);
});

test("层切换键只出现在 layered 底行，且不在 SEQ 里（它不发字节）", () => {
  expect(LAYOUT_BOTTOM_LAYERED.map((k) => k.id)).toContain(LAYER_KEY_ID);
  expect(LAYOUT_BOTTOM_FLICK.map((k) => k.id)).not.toContain(LAYER_KEY_ID);
  expect(SEQ[LAYER_KEY_ID]).toBeUndefined();
});

test("方向键独立成行，两套新布局共用", () => {
  expect(LAYOUT_ARROWS.map((k) => k.id))
    .toEqual(["ArrowLeft", "ArrowUp", "ArrowDown", "ArrowRight"]);
});

test("两套新布局的底行都有 ctrl/alt/space/enter —— 终端高频键不进第二层", () => {
  for (const bottom of [LAYOUT_BOTTOM_LAYERED, LAYOUT_BOTTOM_FLICK]) {
    const ids = bottom.map((k) => k.id);
    for (const need of ["Ctrl", "Alt", "Space", "Enter"]) expect(ids).toContain(need);
  }
});

test("classic 的 LAYOUT 一字未动（回归保护）", () => {
  expect(LAYOUT.length).toBe(5);
  expect(LAYOUT[0].map((k) => k.id)).toEqual(
    ["`", "1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "-", "=", "Backspace"]);
});
