// app/src/lib/keymap.ts
// Static keyboard layout + escape sequences for the custom on-screen keyboard.
// Mobile adaptation: modifiers appear once (sticky), arrows share one bottom row.
export interface KeyCap { id: string; cap: string; up?: string; down?: string; wide?: number }

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

// ---------------------------------------------------------------------------
// 大键位布局（12 期）：一行 10 键，字母键从 24×34 涨到 36×46（触控面积 2 倍）。
// 代价是数字符号放不下，两套布局各用一种办法解决：
//   layered —— 收进第二层，点 123 键切换（全部轻点，无手势）
//   flick   —— 标在键帽右上角，按住上滑取用（不切层，但手势要学）
// classic（上面的 LAYOUT）原样保留，是默认值。
// ---------------------------------------------------------------------------

export type KbLayoutId = "classic" | "layered" | "flick";

/** 层切换键的哨兵 id。它不发字节、不在 SEQ 里，由 Keyboard.svelte 拦下切层。 */
export const LAYER_KEY_ID = "__layer";

/** 方向键独立成行：终端里 ↑ 翻历史、←→ 移光标比任何字母都高频，
 *  classic 把它们和字母挤在一起只有 35×34，独立成行能到 94×46。 */
export const LAYOUT_ARROWS: KeyCap[] = [
  { id: "ArrowLeft", cap: "←" }, { id: "ArrowUp", cap: "↑" },
  { id: "ArrowDown", cap: "↓" }, { id: "ArrowRight", cap: "→" },
];

// ---- layered ----
export const LAYOUT_LAYERED_ALPHA: KeyCap[][] = [
  letters("qwertyuiop"),
  letters("asdfghjkl"),
  [{ id: "Shift", cap: "⇧", wide: 1.5 }, ...letters("zxcvbnm"),
   { id: "Backspace", cap: "⌫", wide: 1.5 }],
];

export const LAYOUT_LAYERED_SYM: KeyCap[][] = [
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]
    .map((c) => ({ id: c, cap: c, up: SHIFT_SYMBOLS[c] })),
  [
    { id: "-", cap: "-", up: "_" }, { id: "=", cap: "=", up: "+" },
    { id: "[", cap: "[", up: "{" }, { id: "]", cap: "]", up: "}" },
    { id: "\\", cap: "\\", up: "|" }, { id: ";", cap: ";", up: ":" },
    { id: "'", cap: "'", up: "\"" }, { id: ",", cap: ",", up: "<" },
    { id: ".", cap: ".", up: ">" }, { id: "/", cap: "/", up: "?" },
  ],
  [
    { id: "Shift", cap: "⇧", wide: 1.5 },
    { id: "`", cap: "`", up: "~" }, { id: "~", cap: "~" }, { id: "|", cap: "|" },
    { id: "&", cap: "&" }, { id: "$", cap: "$" }, { id: "*", cap: "*" },
    { id: "!", cap: "!" },
    { id: "Backspace", cap: "⌫", wide: 1.5 },
  ],
];

/** layered 底行：修饰键 + 层切换 + 空格 + 回车。方向键在 LAYOUT_ARROWS。 */
export const LAYOUT_BOTTOM_LAYERED: KeyCap[] = [
  { id: "Ctrl", cap: "ctrl" }, { id: "Alt", cap: "alt" },
  { id: LAYER_KEY_ID, cap: "123" },
  { id: "Space", cap: "space", wide: 3 },
  { id: "Enter", cap: "⏎", wide: 2 },
];

// ---- flick ----
// up   = 上滑发出的字符，印在键帽右上角。
// down = 下滑发出的字符，印在键帽左下角。
//
// **分配规则只有一条：一个键的上下两滑是一对 Shift 组合**（`-`/`_`、`[`/`{`、
// `1`/`!`…）。用户记一条规则即可，不必记 16 个位置，而且这条规则和笔记本键盘
// 完全一致——`Shift+[` 本来就是 `{`。
//
// 方向不固定在「上=原位、下=shift 位」：a（`~`/`` ` ``）与 l（`:`/`;`）反过来，
// 因为 `~`（家目录）和 `:` 在终端里远比 `` ` `` 和 `;` 常用，高频字符该占更省力
// 的上滑。规则是「成对」，不是「谁在上」。
//
// up 的分配（不动，flick 上线即如此）：数字按 qwerty 行的自然顺序（和笔记本
// 数字行位置对得上），第二三行放 shell 里最常打的符号。
//
// **有 10 个键刻意不配 down**（r u i g h j k z x c）。终端要用的符号一共 32 个，
// 26 个 up 已覆盖 26 个，只缺 16 个——配满 26 个 down 就必然重复，而重复的角标
// 会让「下滑=Shift 位」这条规则出现例外，反而更难记。这些键留白正是因为它们
// up 的 Shift 位已经在别处占了位（`$` 在 c、`&` 在 x、`*` 在 z、`|` 在 h、
// `"` 在 k），规则依然自洽，只是无位可配。
export const LAYOUT_FLICK: KeyCap[][] = [
  [
    { id: "q", cap: "q", up: "1", down: "!" }, { id: "w", cap: "w", up: "2", down: "@" },
    { id: "e", cap: "e", up: "3", down: "#" }, { id: "r", cap: "r", up: "4" },
    { id: "t", cap: "t", up: "5", down: "%" }, { id: "y", cap: "y", up: "6", down: "^" },
    { id: "u", cap: "u", up: "7" }, { id: "i", cap: "i", up: "8" },
    { id: "o", cap: "o", up: "9", down: "(" }, { id: "p", cap: "p", up: "0", down: ")" },
  ],
  [
    { id: "a", cap: "a", up: "~", down: "`" }, { id: "s", cap: "s", up: "-", down: "_" },
    { id: "d", cap: "d", up: "=", down: "+" }, { id: "f", cap: "f", up: "/", down: "?" },
    { id: "g", cap: "g", up: "\\" }, { id: "h", cap: "h", up: "|" },
    { id: "j", cap: "j", up: "'" }, { id: "k", cap: "k", up: "\"" },
    { id: "l", cap: "l", up: ":", down: ";" },
  ],
  [
    { id: "Shift", cap: "⇧", wide: 1.5 },
    { id: "z", cap: "z", up: "*" }, { id: "x", cap: "x", up: "&" },
    { id: "c", cap: "c", up: "$" }, { id: "v", cap: "v", up: "[", down: "{" },
    { id: "b", cap: "b", up: "]", down: "}" }, { id: "n", cap: "n", up: ".", down: ">" },
    { id: "m", cap: "m", up: ",", down: "<" },
    { id: "Backspace", cap: "⌫", wide: 1.5 },
  ],
];

/** flick 底行：不需要层切换键，空出来的位置给 ctrl/alt 更宽的落点。 */
export const LAYOUT_BOTTOM_FLICK: KeyCap[] = [
  { id: "Ctrl", cap: "ctrl" }, { id: "Alt", cap: "alt" },
  { id: "Space", cap: "space", wide: 3 },
  { id: "Enter", cap: "⏎", wide: 2 },
];
