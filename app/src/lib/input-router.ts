// app/src/lib/input-router.ts
// Pure input routing: modifier sticky state machine + key → PTY bytes / app command.
import { SEQ, SHIFT_SYMBOLS } from "./keymap";

export type ModName = "Shift" | "Ctrl" | "Alt" | "Cmd" | "Fn" | "Caps";
export type ModPhase = "off" | "armed" | "locked";
export type ModState = Record<ModName, ModPhase>;

export const EMPTY_MODS: ModState = { Shift: "off", Ctrl: "off", Alt: "off", Cmd: "off", Fn: "off", Caps: "off" };

const NEXT: Record<ModPhase, ModPhase> = { off: "armed", armed: "locked", locked: "off" };

/** Tap a modifier: cycles off → armed(one-shot) → locked → off. */
export function tapMod(s: ModState, m: ModName): ModState {
  return { ...s, [m]: NEXT[s[m]] };
}

export interface Mods { shift: boolean; caps: boolean; ctrl: boolean; alt: boolean; cmd: boolean; fn: boolean }

export function activeMods(s: ModState): Mods {
  const on = (p: ModPhase) => p !== "off";
  return { shift: on(s.Shift), caps: on(s.Caps), ctrl: on(s.Ctrl), alt: on(s.Alt), cmd: on(s.Cmd), fn: on(s.Fn) };
}

/** After a normal (non-modifier) key press, armed modifiers release; locked stay. */
export function consumeAfterKey(s: ModState): ModState {
  const out = { ...s };
  for (const k of Object.keys(out) as ModName[]) if (out[k] === "armed") out[k] = "off";
  return out;
}

// ---- resolveKey ----

export type AppCommand =
  | { type: "prevTab" } | { type: "nextTab" }
  | { type: "newSession" } | { type: "toBackground" }
  | { type: "gotoTab"; index: number }
  | { type: "scrollUp" } | { type: "scrollDown" }
  | { type: "toggleFullscreen" } | { type: "copyVisible" } | { type: "renameSession" }
  | { type: "selBegin" }
  | { type: "selMove"; dir: "up" | "down" | "left" | "right" }
  | { type: "selCancel" }
  | { type: "selCopy" }
  | { type: "copyAfter" }
  | { type: "selectAllCopy" }
  | { type: "paste" };

export type KeyResult =
  | { kind: "bytes"; text: string }
  | { kind: "command"; command: AppCommand }
  | { kind: "none" };

const FN_LETTER: Record<string, AppCommand> = {
  n: { type: "newSession" }, d: { type: "toBackground" },
  f: { type: "toggleFullscreen" }, c: { type: "copyVisible" }, r: { type: "renameSession" },
};

const ARROW_DIR: Record<string, "up" | "down" | "left" | "right"> = {
  ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
};

function fnCommand(id: string): KeyResult {
  if (id === "ArrowLeft") return { kind: "command", command: { type: "prevTab" } };
  if (id === "ArrowRight") return { kind: "command", command: { type: "nextTab" } };
  if (id === "ArrowUp") return { kind: "command", command: { type: "scrollUp" } };
  if (id === "ArrowDown") return { kind: "command", command: { type: "scrollDown" } };
  if (FN_LETTER[id]) return { kind: "command", command: FN_LETTER[id] };
  if (/^[1-9]$/.test(id)) return { kind: "command", command: { type: "gotoTab", index: Number(id) - 1 } };
  return { kind: "none" };
}

/** Resolve a keycap id + active modifiers into PTY bytes or an app command. */
export function resolveKey(id: string, m: Mods, selecting = false): KeyResult {
  if (m.fn) return fnCommand(id);
  if (selecting && id in ARROW_DIR) {
    return { kind: "command", command: { type: "selMove", dir: ARROW_DIR[id] } };
  }
  if (id in SEQ) return { kind: "bytes", text: SEQ[id] };

  // Single printable char (letter / digit / symbol).
  if (id.length === 1) {
    let ch = id;
    if (m.shift && SHIFT_SYMBOLS[id]) ch = SHIFT_SYMBOLS[id];
    const isLetter = /^[a-z]$/.test(id);
    if (isLetter && (m.shift !== m.caps)) ch = id.toUpperCase(); // XOR: shift or caps (not both) upcases
    if (m.ctrl && isLetter) return { kind: "bytes", text: String.fromCharCode(id.toUpperCase().charCodeAt(0) & 0x1f) };
    if (m.alt) return { kind: "bytes", text: "\x1b" + ch };
    return { kind: "bytes", text: ch };
  }
  return { kind: "none" };
}
