// app/src/fonts.test.ts
// 字体产物的字形校验。为什么值得为它引一条 Python 工具链：终端字体缺一个
// 制表符字形，屏幕上不会报错——只会在 tmux 画框时悄悄回落到系统字体，
// 接缝错开一两像素。人眼走查极易放过，而 CI 一测就知道。
//
// 解析 woff2 需要 brotli + 字体表解析，Node 侧没有现成依赖；build-fonts.ts
// 本就依赖 fontTools，这里复用同一条链（uv），不给运行时增加任何东西。
import { test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const FONTS_DIR = resolve(__dirname, "../public/fonts");

/** 本计划新增的 4 套（JetBrains Mono 是既有文件，命名与子集范围都不同，另测）。 */
const SUBSET_FONTS = ["maple-mono", "google-sans-code", "monaspace-neon", "ubuntu-mono"];

/** 终端必需的四类字形。缺任何一类都会在终端里静默回落系统字体。 */
const PY = `
import sys, json
from fontTools.ttLib import TTFont
out = {}
for path in sys.argv[1:]:
    f = TTFont(path)
    cm = f.getBestCmap()
    hm = f["hmtx"].metrics
    def have(rng):
        return sum(1 for c in rng if c in cm)
    ascii_w = {hm[cm[c]][0] for c in range(0x41, 0x5B) if c in cm}
    box_w = {hm[cm[c]][0] for c in range(0x2500, 0x2510) if c in cm}
    out[path] = {
        "box": have(range(0x2500, 0x2580)),
        "block": have(range(0x2580, 0x25A0)),
        "braille": have(range(0x2800, 0x2900)),
        "powerline": have([0xE0A0, 0xE0A1, 0xE0A2, 0xE0B0, 0xE0B1, 0xE0B2, 0xE0B3]),
        "asciiWidths": sorted(ascii_w),
        "boxWidths": sorted(box_w),
    }
print(json.dumps(out))
`;

interface FontStats {
  box: number; block: number; braille: number; powerline: number;
  asciiWidths: number[]; boxWidths: number[];
}

function inspect(paths: string[]): Record<string, FontStats> {
  const out = execFileSync(
    "uv",
    ["run", "--quiet", "--with", "fonttools", "--with", "brotli", "python3", "-c", PY, ...paths],
    { encoding: "utf8" },
  );
  return JSON.parse(out);
}

test("4 套新字体的 woff2 产物都在", () => {
  for (const id of SUBSET_FONTS) {
    for (const w of ["regular", "bold"]) {
      const p = `${FONTS_DIR}/${id}-${w}.woff2`;
      expect(existsSync(p), `缺产物 ${p}——跑 cd app && bun run gen:fonts`).toBe(true);
    }
  }
});

test("每套字体的终端字形齐全", () => {
  const paths = SUBSET_FONTS.flatMap((id) =>
    ["regular", "bold"].map((w) => `${FONTS_DIR}/${id}-${w}.woff2`),
  );
  const stats = inspect(paths);
  for (const [p, s] of Object.entries(stats)) {
    expect(s.box, `${p} 缺制表符（tmux 画框会掉回系统字体）`).toBe(128);
    expect(s.block, `${p} 缺块元素`).toBe(32);
    expect(s.braille, `${p} 缺盲文（部分 TUI 进度条用它）`).toBe(256);
    expect(s.powerline, `${p} 缺 Powerline（starship/tmux 分隔符）`).toBe(7);
  }
});

test("ASCII 与制表符等宽——不等就会框线错位", () => {
  const paths = SUBSET_FONTS.flatMap((id) =>
    ["regular", "bold"].map((w) => `${FONTS_DIR}/${id}-${w}.woff2`),
  );
  const stats = inspect(paths);
  for (const [p, s] of Object.entries(stats)) {
    expect(s.asciiWidths, `${p} 的 ASCII 字母本身就不等宽`).toHaveLength(1);
    expect(s.boxWidths, `${p} 的制表符本身就不等宽`).toHaveLength(1);
    expect(s.boxWidths[0], `${p} 制表符宽 ≠ ASCII 宽，终端框线会错位`).toBe(s.asciiWidths[0]);
  }
});
