// app/src/lib/keymap.ts
// Static keyboard layout + escape sequences for the custom on-screen keyboard.
// Mobile adaptation: modifiers appear once (sticky), arrows share one bottom row.
export interface KeyCap { id: string; cap: string; up?: string; wide?: number }

export const MOD_IDS = ["Shift", "Ctrl", "Alt", "Cmd", "Fn", "Caps"] as const;

// Special-key id → bytes to send to the PTY (as a string; encoded at send time).
export const SEQ: Record<string, string> = {
  ArrowUp: "\x1b[A", ArrowDown: "\x1b[B", ArrowRight: "\x1b[C", ArrowLeft: "\x1b[D",
  Esc: "\x1b", Tab: "\x09", Enter: "\r", Backspace: "\x7f", Space: " ",
  F1: "\x1bOP", F2: "\x1bOQ", F3: "\x1bOR", F4: "\x1bOS",
  F5: "\x1b[15~", F6: "\x1b[17~", F7: "\x1b[18~", F8: "\x1b[19~",
  F9: "\x1b[20~", F10: "\x1b[21~", F11: "\x1b[23~", F12: "\x1b[24~",
  Home: "\x1b[H", End: "\x1b[F", PgUp: "\x1b[5~", PgDn: "\x1b[6~",
  Del: "\x1b[3~",
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

// Function keys and Esc are rendered by Keyboard's dedicated function row
// (hint bar ↔ F1–F12), not as part of the static LAYOUT grid.
export const FKEYS: KeyCap[] = Array.from({ length: 12 }, (_, i) => ({ id: `F${i + 1}`, cap: `F${i + 1}` }));
export const ESC_KEY: KeyCap = { id: "Esc", cap: "Esc" };

export const LAYOUT: KeyCap[][] = [
  // 数字行
  [
    { id: "`", cap: "`", up: "~" },
    ...["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"].map((c) => ({ id: c, cap: c, up: SHIFT_SYMBOLS[c] })),
    { id: "-", cap: "-", up: "_" },
    { id: "=", cap: "=", up: "+" },
    { id: "Backspace", cap: "⌫", wide: 1.5 },
  ],
  // Q 行
  [{ id: "Tab", cap: "Tab", wide: 1.3 }, ...letters("qwertyuiop"),
   { id: "[", cap: "[", up: "{" }, { id: "]", cap: "]", up: "}" }, { id: "\\", cap: "\\", up: "|" }],
  // A 行
  [{ id: "Caps", cap: "Caps", wide: 1.5 }, ...letters("asdfghjkl"),
   { id: ";", cap: ";", up: ":" }, { id: "'", cap: "'", up: "\"" }, { id: "Enter", cap: "⏎", wide: 1.5 }],
  // Z 行
  [{ id: "Shift", cap: "Shift", wide: 1.5 }, ...letters("zxcvbnm"),
   { id: ",", cap: ",", up: "<" }, { id: ".", cap: ".", up: ">" }, { id: "/", cap: "/", up: "?" }],
  // 底行：修饰键各一个（不左右重复）+ 空格 + 方向键单排
  [
    { id: "Ctrl", cap: "Ctrl" }, { id: "Fn", cap: "Fn" }, { id: "Alt", cap: "Alt" }, { id: "Cmd", cap: "Cmd" },
    { id: "Space", cap: "space", wide: 3 },
    { id: "ArrowLeft", cap: "←" }, { id: "ArrowUp", cap: "↑" }, { id: "ArrowDown", cap: "↓" }, { id: "ArrowRight", cap: "→" },
  ],
];
