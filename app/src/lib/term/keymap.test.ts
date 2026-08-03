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
