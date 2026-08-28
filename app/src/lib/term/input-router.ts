// app/src/lib/input-router.ts
// Pure input routing: modifier sticky state machine + key → PTY bytes / app command.
import { SEQ, SHIFT_SYMBOLS } from "./keymap";

export type ModName = "Shift" | "Ctrl" | "Alt" | "Cmd" | "Fn" | "Caps";
export type ModPhase = "off" | "armed" | "locked";
export type ModState = Record<ModName, ModPhase>;

export const EMPTY_MODS: ModState = { Shift: "off", Ctrl: "off", Alt: "off", Cmd: "off", Fn: "off", Caps: "off" };

// 【2026-08-28 误锁陷阱修正】轻点不再进入 locked：旧循环 off→armed→locked→off 里，
// 「连点两下再按字母」与「点一下再按字母」在按下字母那一刻完全等价（armed 和
// locked 都让下一个键带修饰），用户无从分辨自己已把 Ctrl 锁死——真机实锤一例：
// Ctrl+C 退出 Claude Code 时多按了一下 Ctrl，之后所有字母都以 1 字节控制码发
// 出，cc 的输入框永远打不进字（「输入的内容看不到」排查了三天的真根因）。
// 锁定改为**长按**专用（lockMod，Keyboard.svelte 里 500ms 长按触发），轻点只做
// armed 开关；锁定态的可见性由键盘顶栏的锁定芯片兜底。
const TAP: Record<ModPhase, ModPhase> = { off: "armed", armed: "off", locked: "off" };

/** Tap a modifier: toggles the one-shot armed state; tapping a locked mod releases it. */
export function tapMod(s: ModState, m: ModName): ModState {
  return { ...s, [m]: TAP[s[m]] };
}

/** Long-press a modifier: lock it on (idempotent — long-pressing a locked mod keeps it). */
export function lockMod(s: ModState, m: ModName): ModState {
  return { ...s, [m]: "locked" };
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
  | { type: "lineUp" }
  | { type: "lineDown" }
  | { type: "selCancel" }
  | { type: "selCopy" }
  | { type: "copyMode" }
  | { type: "selectAllCopy" }
  | { type: "paste" }
  | { type: "togglePageFullscreen" }
  | { type: "smartCopy" }
  | { type: "clearScreen" };

export type KeyResult =
  | { kind: "bytes"; text: string }
  | { kind: "command"; command: AppCommand }
  | { kind: "none" };

const FN_LETTER: Record<string, AppCommand> = {
  n: { type: "newSession" }, d: { type: "toBackground" },
  f: { type: "toggleFullscreen" }, c: { type: "copyVisible" }, r: { type: "renameSession" },
};

// Cmd (GUI) shortcuts — Ctrl stays terminal control chars, Cmd carries GUI ops.
const CMD_LETTER: Record<string, AppCommand> = {
  a: { type: "selectAllCopy" }, c: { type: "smartCopy" }, v: { type: "paste" },
  f: { type: "togglePageFullscreen" }, n: { type: "newSession" },
  r: { type: "renameSession" }, k: { type: "clearScreen" },
};

const ARROW_DIR: Record<string, "up" | "down" | "left" | "right"> = {
  ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
};

function fnCommand(id: string): KeyResult {
  if (/^F([1-9]|1[0-2])$/.test(id)) return { kind: "bytes", text: SEQ[id] };
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
  if (m.cmd) {
    if (id === "ArrowLeft") return { kind: "command", command: { type: "prevTab" } };
    if (id === "ArrowRight") return { kind: "command", command: { type: "nextTab" } };
    const lower = id.length === 1 ? id.toLowerCase() : id;
    if (CMD_LETTER[lower]) return { kind: "command", command: CMD_LETTER[lower] };
    return { kind: "none" };
  }
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
