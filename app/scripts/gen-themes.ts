// Generate app/src/theme-tokens.css from the built-in Ghostty palettes in
// app/themes/*.ghostty. Usage: cd app && bun run gen:themes
//
// The derivation itself lives in agent/src/theme-derive.ts and is imported
// across the package boundary on purpose: the agent serves user-imported
// themes through the *same* functions at run time, and two implementations of
// a colour algorithm would drift without ever failing to compile. This is a
// build-time import only — nothing from agent/ reaches the browser bundle.
//
// Output shape (see docs/superpowers/specs/2026-08-05-ghostty主题体系-design.md §4.4):
//   1. a manifest `:root` with the theme list, per-theme scheme flags and the
//      five swatch colours of *every* theme — attribute-less so the settings
//      panel can read what theme X looks like while theme Y is active;
//   2. one block per theme. The default renders as a bare `:root` so the very
//      first frame has a full token set before any `data-theme` is applied.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseGhostty, derive, renderCss, isLightBackground,
} from "../../agent/src/theme-derive";

const THEME_DIR = join(import.meta.dir, "../themes");
const OUT = join(import.meta.dir, "../src/theme-tokens.css");

/** The theme whose tokens render as a bare `:root` — first paint, and the
 *  fallback whenever a stored preference names a theme that no longer ships. */
const DEFAULT_THEME = "cream-dark";

/** Menu order. Files not listed here still ship; they are appended
 *  alphabetically, so dropping a `.ghostty` into app/themes/ is enough. */
const ORDER = [
  "cream-dark", "cream-light", "gruvbox-dark", "tokyonight", "nord", "mocha", "blackout",
];

/** Colours the settings panel paints as a preview strip, in swatch order:
 *  机身 / 面板 / 主色 / 运行灯 / 文字. */
const SWATCH = ["--bg", "--panel", "--accent", "--ok", "--text"] as const;
const SWATCH_SUFFIX = ["bg", "panel", "accent", "ok", "text"] as const;

function themeIds(): string[] {
  const found = readdirSync(THEME_DIR)
    .filter((f) => f.endsWith(".ghostty"))
    .map((f) => f.slice(0, -".ghostty".length))
    .sort();
  const known = ORDER.filter((id) => found.includes(id));
  const extra = found.filter((id) => !ORDER.includes(id));
  const ids = [...known, ...extra];
  if (!ids.includes(DEFAULT_THEME)) {
    throw new Error(`default theme "${DEFAULT_THEME}.ghostty" is missing from ${THEME_DIR}`);
  }
  return ids;
}

function main(): void {
  const ids = themeIds();
  const themes = ids.map((id) => {
    const file = `${id}.ghostty`;
    const parsed = parseGhostty(readFileSync(join(THEME_DIR, file), "utf8"), file);
    return { id, parsed, tokens: derive(parsed) };
  });

  const manifest: string[] = [`  --ps-themes: "${ids.join(",")}";`, ""];
  for (const { id, parsed, tokens } of themes) {
    const scheme = isLightBackground(parsed.background) ? "light" : "dark";
    manifest.push(`  --ps-scheme-${id}: ${scheme};`);
    SWATCH.forEach((token, i) => {
      manifest.push(`  --sw-${id}-${SWATCH_SUFFIX[i]}: ${tokens[token]};`);
    });
    manifest.push("");
  }
  while (manifest.at(-1) === "") manifest.pop();

  const parts = [
    "/* ==========================================================================",
    "   theme-tokens.css — 本文件由 `bun run gen:themes` 生成，勿手改。",
    "   改颜色请改 app/themes/<id>.ghostty（22 个色值），或改派生规则",
    "   agent/src/theme-derive.ts，然后重跑生成器。",
    "",
    "   生成物提交进仓库，好处是配色变化能在 review 里逐值 diff。",
    `   默认主题 ${DEFAULT_THEME} 渲染为无属性的 :root——首帧还没写 data-theme 时`,
    "   也拿得到整套令牌。",
    "   ========================================================================== */",
    "",
    "/* 主题清单 + 各主题明暗标记 + 预览色。放在无属性 :root 里是有意的：",
    "   设置面板要在 A 主题激活时展示 B 主题长什么样，所以这些值任何时候都可读。 */",
    `:root {\n${manifest.join("\n")}\n}\n`,
  ];

  for (const { id, tokens } of themes) {
    const isDefault = id === DEFAULT_THEME;
    parts.push(`/* theme: ${id}${isDefault ? " (default)" : ""} */`);
    parts.push(renderCss(tokens, isDefault ? ":root" : `:root[data-theme="${id}"]`));
  }

  writeFileSync(OUT, parts.join("\n"));
  console.log(`gen:themes → src/theme-tokens.css (${themes.length} themes: ${ids.join(", ")})`);
}

main();
