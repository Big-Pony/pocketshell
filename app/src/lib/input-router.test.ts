// app/src/lib/input-router.test.ts
import { test, expect } from "vitest";
import { EMPTY_MODS, tapMod, activeMods, consumeAfterKey, resolveKey } from "./input-router";

// ---- Task 7: Modifier sticky state machine ----

test("tapMod cycles off -> armed -> locked -> off", () => {
  let s = EMPTY_MODS;
  s = tapMod(s, "Ctrl"); expect(s.Ctrl).toBe("armed");
  s = tapMod(s, "Ctrl"); expect(s.Ctrl).toBe("locked");
  s = tapMod(s, "Ctrl"); expect(s.Ctrl).toBe("off");
});

test("activeMods is true for armed and locked", () => {
  let s = tapMod(EMPTY_MODS, "Shift");        // armed
  expect(activeMods(s).shift).toBe(true);
  s = tapMod(s, "Shift");                       // locked
  expect(activeMods(s).shift).toBe(true);
});

test("consumeAfterKey clears armed, keeps locked", () => {
  let s = tapMod(EMPTY_MODS, "Ctrl");           // armed
  s = tapMod(s, "Shift"); s = tapMod(s, "Shift"); // Shift locked
  const after = consumeAfterKey(s);
  expect(after.Ctrl).toBe("off");   // armed consumed
  expect(after.Shift).toBe("locked"); // locked stays
});

// ---- Task 8: resolveKey ----

const M = (over: Partial<import("./input-router").Mods> = {}) =>
  ({ shift: false, caps: false, ctrl: false, alt: false, cmd: false, fn: false, ...over });

test("plain letter and shift/caps casing", () => {
  expect(resolveKey("a", M())).toEqual({ kind: "bytes", text: "a" });
  expect(resolveKey("a", M({ shift: true }))).toEqual({ kind: "bytes", text: "A" });
  expect(resolveKey("a", M({ caps: true }))).toEqual({ kind: "bytes", text: "A" });
});

test("shifted number becomes symbol", () => {
  expect(resolveKey("1", M({ shift: true }))).toEqual({ kind: "bytes", text: "!" });
});

test("ctrl+letter -> control char", () => {
  expect(resolveKey("c", M({ ctrl: true }))).toEqual({ kind: "bytes", text: "\x03" });
  expect(resolveKey("d", M({ ctrl: true }))).toEqual({ kind: "bytes", text: "\x04" });
});

test("alt+char -> ESC prefix", () => {
  expect(resolveKey("b", M({ alt: true }))).toEqual({ kind: "bytes", text: "\x1bb" });
});

test("special keys map to escape sequences", () => {
  expect(resolveKey("ArrowLeft", M())).toEqual({ kind: "bytes", text: "\x1b[D" });
  expect(resolveKey("Enter", M())).toEqual({ kind: "bytes", text: "\r" });
  expect(resolveKey("F1", M())).toEqual({ kind: "bytes", text: "\x1bOP" });
});

test("fn layer maps to app commands, not PTY", () => {
  expect(resolveKey("ArrowLeft", M({ fn: true }))).toEqual({ kind: "command", command: { type: "prevTab" } });
  expect(resolveKey("ArrowRight", M({ fn: true }))).toEqual({ kind: "command", command: { type: "nextTab" } });
  expect(resolveKey("ArrowUp", M({ fn: true }))).toEqual({ kind: "command", command: { type: "scrollUp" } });
  expect(resolveKey("ArrowDown", M({ fn: true }))).toEqual({ kind: "command", command: { type: "scrollDown" } });
  expect(resolveKey("n", M({ fn: true }))).toEqual({ kind: "command", command: { type: "newSession" } });
  expect(resolveKey("d", M({ fn: true }))).toEqual({ kind: "command", command: { type: "toBackground" } });
  expect(resolveKey("f", M({ fn: true }))).toEqual({ kind: "command", command: { type: "toggleFullscreen" } });
  expect(resolveKey("c", M({ fn: true }))).toEqual({ kind: "command", command: { type: "copyVisible" } });
  expect(resolveKey("r", M({ fn: true }))).toEqual({ kind: "command", command: { type: "renameSession" } });
  expect(resolveKey("3", M({ fn: true }))).toEqual({ kind: "command", command: { type: "gotoTab", index: 2 } });
  expect(resolveKey("x", M({ fn: true }))).toEqual({ kind: "none" });
});

test("Fn+F1 sends the F1 escape sequence", () => {
  expect(resolveKey("F1", M({ fn: true }))).toEqual({ kind: "bytes", text: "\x1bOP" });
});

test("Fn+F12 sends the F12 escape sequence", () => {
  expect(resolveKey("F12", M({ fn: true }))).toEqual({ kind: "bytes", text: "\x1b[24~" });
});

test("Fn layer: arrows still map to app commands (regression)", () => {
  expect(resolveKey("ArrowLeft", M({ fn: true }))).toEqual({ kind: "command", command: { type: "prevTab" } });
});

test("without Fn, F1 still sends its escape sequence (regression)", () => {
  expect(resolveKey("F1", M())).toEqual({ kind: "bytes", text: "\x1bOP" });
});

test("selecting mode: bare arrows become selMove commands", () => {
  expect(resolveKey("ArrowUp", M(), true)).toEqual({ kind: "command", command: { type: "selMove", dir: "up" } });
  expect(resolveKey("ArrowDown", M(), true)).toEqual({ kind: "command", command: { type: "selMove", dir: "down" } });
  expect(resolveKey("ArrowLeft", M(), true)).toEqual({ kind: "command", command: { type: "selMove", dir: "left" } });
  expect(resolveKey("ArrowRight", M(), true)).toEqual({ kind: "command", command: { type: "selMove", dir: "right" } });
});

test("selecting mode: Fn+arrow still switches tabs (Fn wins)", () => {
  expect(resolveKey("ArrowLeft", M({ fn: true }), true)).toEqual({ kind: "command", command: { type: "prevTab" } });
});

test("selecting mode: non-arrow keys are unaffected", () => {
  expect(resolveKey("a", M(), true)).toEqual({ kind: "bytes", text: "a" });
  expect(resolveKey("Home", M(), true)).toEqual({ kind: "bytes", text: "\x1b[H" });
});

test("selecting defaults to false: bare arrow still sends bytes", () => {
  expect(resolveKey("ArrowUp", M())).toEqual({ kind: "bytes", text: "\x1b[A" });
});
