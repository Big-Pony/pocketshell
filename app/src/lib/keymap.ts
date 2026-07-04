// app/src/lib/keymap.ts
// Static keyboard layout + escape sequences for the custom on-screen keyboard.
// Mobile adaptation: modifiers appear once (sticky), arrows share one bottom row.
export interface KeyCap { id: string; cap: string; wide?: number }

export const MOD_IDS = ["Shift", "Ctrl", "Alt", "Cmd", "Fn", "Caps"] as const;

// Special-key id → bytes to send to the PTY (as a string; encoded at send time).
export const SEQ: Record<string, string> = {
  ArrowUp: "\x1b[A", ArrowDown: "\x1b[B", ArrowRight: "\x1b[C", ArrowLeft: "\x1b[D",
  Esc: "\x1b", Tab: "\x09", Enter: "\r", Backspace: "\x7f", Space: " ",
  F1: "\x1bOP", F2: "\x1bOQ", F3: "\x1bOR", F4: "\x1bOS",
  F5: "\x1b[15~", F6: "\x1b[17~", F7: "\x1b[18~", F8: "\x1b[19~",
  F9: "\x1b[20~", F10: "\x1b[21~", F11: "\x1b[23~", F12: "\x1b[24~",
};

// Unshifted char → shifted char (US layout).
export const SHIFT_SYMBOLS: Record<string, string> = {
  "1": "!", "2": "@", "3": "#", "4": "$", "5": "%", "6": "^", "7": "&", "8": "*",
  "9": "(", "0": ")", "-": "_", "=": "+", "[": "{", "]": "}", "\\": "|",
  ";": ":", "'": "\"", ",": "<", ".": ">", "/": "?", "`": "~",
};

// Keycap label may differ by layout. Currently only the Cmd/Win key: macOS shows
// "Cmd", Windows shows "Win" (same id "Cmd" — both map to Meta in the terminal).
export function capFor(k: KeyCap, layout: "mac" | "win"): string {
  if (k.id === "Cmd") return layout === "win" ? "Win" : "Cmd";
  return k.cap;
}

const letters = (s: string): KeyCap[] => s.split("").map((c) => ({ id: c, cap: c.toUpperCase() }));
const fkeys = Array.from({ length: 12 }, (_, i) => ({ id: `F${i + 1}`, cap: `F${i + 1}` }));

export const LAYOUT: KeyCap[][] = [
  // 功能行
  [{ id: "Esc", cap: "Esc" }, ...fkeys],
  // 数字行
  [
    { id: "`", cap: "`" }, ...letters("1234567890"),
    { id: "-", cap: "-" }, { id: "=", cap: "=" }, { id: "Backspace", cap: "⌫", wide: 1.5 },
  ],
  // Q 行
  [{ id: "Tab", cap: "Tab", wide: 1.3 }, ...letters("qwertyuiop"),
   { id: "[", cap: "[" }, { id: "]", cap: "]" }, { id: "\\", cap: "\\" }],
  // A 行
  [{ id: "Caps", cap: "Caps", wide: 1.5 }, ...letters("asdfghjkl"),
   { id: ";", cap: ";" }, { id: "'", cap: "'" }, { id: "Enter", cap: "⏎", wide: 1.5 }],
  // Z 行
  [{ id: "Shift", cap: "Shift", wide: 1.5 }, ...letters("zxcvbnm"),
   { id: ",", cap: "," }, { id: ".", cap: "." }, { id: "/", cap: "/" }],
  // 底行：修饰键各一个（不左右重复）+ 空格 + 方向键单排
  [
    { id: "Ctrl", cap: "Ctrl" }, { id: "Fn", cap: "Fn" }, { id: "Alt", cap: "Alt" }, { id: "Cmd", cap: "Cmd" },
    { id: "Space", cap: "space", wide: 3 },
    { id: "ArrowLeft", cap: "←" }, { id: "ArrowUp", cap: "↑" }, { id: "ArrowDown", cap: "↓" }, { id: "ArrowRight", cap: "→" },
  ],
];
