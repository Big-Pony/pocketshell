// app/src/lib/theme-css.ts
// 主题清单/明暗/预览色的**唯一真相是 CSS 自己**（`src/theme-tokens.css` 的清单块，
// 加上 agent 供给的 `/theme/custom.css`）。本模块只做纯逻辑：解析清单串、拼令牌名、
// 自定义主题 id 的编解码与安全校验。
//
// 读取函数以参数注入（`CssReader`），本模块**不碰 `getComputedStyle`**——
// 这样它在 jsdom 下可测，也不必假装 CSS 已经到位。真正的读取器在 `theme.ts`。
//
// 为什么不再把清单写在 TS 里：那是 2026-08-05 之前的做法，主题列表 / 浅色集合 /
// 每套的预览色三份手抄散在 theme.ts、settings.ts、index.html、demo.html 里，
// 加一套主题要改四处，漏一处就是静默的错色。现在它们都从 CSS 读。

/** 读一个 CSS 自定义属性的字面值；读不到返回空串（不要抛）。 */
export type CssReader = (prop: string) => string;

export type Scheme = "dark" | "light";

/** 内置主题清单令牌（`theme-tokens.css` 的无属性 `:root` 里）。 */
export const MANIFEST_BUILTIN = "--ps-themes";
/** 用户自定义主题清单令牌（agent 的 `/theme/custom.css` 里，名字不带 `custom:` 前缀）。 */
export const MANIFEST_CUSTOM = "--ps-custom-themes";

/** 自定义主题 id 的前缀。`custom:foo` 是 id，`foo` 是文件名/展示名。 */
export const CUSTOM_PREFIX = "custom:";

/** 预览色后缀，顺序即设置面板色板顺序：机身 / 面板 / 主色 / 运行灯 / 文字。 */
export const SWATCH_SUFFIXES = ["bg", "panel", "accent", "ok", "text"] as const;

/** keyDir 里找到的 `.ghostty` 文件总数（含被截断掉的）。 */
export const MANIFEST_TOTAL = "--ps-custom-total";
/** 是否触到 50 套上限。**不能用 `total > shown` 推**——有文件被跳过时那两个数
 *  本来就不等，据此提示「只显示了前 1 个」是假话，真正的原因就在下面的跳过清单里。 */
export const MANIFEST_TRUNCATED = "--ps-custom-truncated";
/** 被跳过的文件，`reason:file` 逗号分隔。agent 侧 `encodeSkips()` 编的。 */
export const MANIFEST_SKIPPED = "--ps-custom-skipped";

/**
 * 主题 id 的安全字符集。
 *
 * id 会被拼进 CSS 选择器（`[data-theme="…"]`）与自定义属性名
 * （`--ps-scheme-…`），所以引号、反斜杠、大括号、分号、换行、空白一律拒绝——
 * 不是怕远程攻击（数据来自本机 localStorage 与本机 agent），而是这类字符会让
 * 选择器**静默失配**：主题看着没生效，却查不出为什么。
 *
 * 2026-08-05 之后内置与自定义**同一套语法**：小写 kebab。以前自定义名额外放行
 * 大写、下划线与点（那时 id 就是文件名），现在 id 是 `slugThemeId()` 的产物，
 * 一定是小写 kebab——放行更宽的字符集只会让「agent 发来的 id 不是它自己的 slug」
 * 这种不一致悄悄通过。旧的 `custom:My_Theme` 落到这里会被判不安全并回落默认，
 * 与「文件已改名/已删除」是同一种结局，符合 loadSettings 的既有行为。
 */
const THEME_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** 防呆上限，够长到装下任何真实主题名，短到不会撑爆选择器。 */
const MAX_NAME = 64;

/** 32 位 FNV-1a，十六进制。只用来给「一个 ASCII 字符都没有」的名字一个稳定且
 *  互不相同的 id，不承担任何安全职责。与 agent 侧同名函数逐字一致。 */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * 文件名 → 主题 id。**必须与 agent 的 `theme-store.ts` 里同名函数逐字一致**，
 * 两边由 `theme-css.test.ts` 的对拍用例钉住。
 *
 * 为什么要 slug：上游 `mbadolato/iTerm2-Color-Schemes` 那 602 套主题大量带空格
 * （`Tokyo Night`、`3024 Day`），而 id 会进 CSS 自定义属性名——`--sw-custom-3024
 * Day-bg` 在空格处断掉，整条声明被浏览器静默丢弃。让用户为了用一套官方主题去改
 * 文件名，是比自动转换更差的答案。**展示名仍是原文件名**，只有 id 被 slug。
 *
 * 规则：NFKD 去掉组合符（`Café` → `Cafe`）→ 转小写 → 非 `[a-z0-9]` 的连续段并成
 * 一个 `-` → 去首尾 `-` → 截到 64 → 再去一次尾部 `-`（截断可能切出来一个）。
 * slug 成空串（如 `我的主题`，没有 ASCII 归宿）时兜底 `theme-<原名哈希>`。
 */
export function slugThemeId(name: string): string {
  const folded = name.normalize("NFKD").replace(/\p{M}+/gu, "");
  const slug = folded
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_NAME)
    .replace(/-+$/, "");
  return slug || `theme-${fnv1a(name)}`;
}

export function isCustomTheme(id: string): boolean {
  return id.startsWith(CUSTOM_PREFIX);
}

/** `custom:foo` → `foo`；不是自定义 id 则返回 null。 */
export function customThemeName(id: string): string | null {
  return isCustomTheme(id) ? id.slice(CUSTOM_PREFIX.length) : null;
}

/** `foo` → `custom:foo`（已带前缀则原样返回，避免 `custom:custom:foo`）。 */
export function customThemeId(name: string): string {
  return isCustomTheme(name) ? name : CUSTOM_PREFIX + name;
}

/**
 * id 是否可安全拼进选择器与令牌名。`custom:` 前缀剥掉后规则与内置相同。
 *
 * 长度上限量的是**去掉前缀之后**的那一段：agent 的文件名上限就是 64，
 * `slugThemeId()` 也按 64 截，把 `custom:` 这 7 个字节算进来的话，一个刚好 64 字符
 * 的合法 slug 会在这里被判不安全——主题拿得到令牌却切不过去，且毫无提示。
 */
export function isSafeThemeId(id: string): boolean {
  if (typeof id !== "string" || id.length === 0) return false;
  const name = customThemeName(id) ?? id;
  if (name.length === 0 || name.length > MAX_NAME) return false;
  return THEME_ID.test(name);
}

/**
 * id → 令牌名里用的片段。
 *
 * CSS 自定义属性名是一个 ident，**冒号不合法**（`--ps-scheme-custom:foo` 会被
 * 解析器丢弃），所以自定义主题在令牌名里把 `custom:` 换成 `custom-`。
 * 选择器里则保持原样（`[data-theme="custom:foo"]` 的引号里冒号没问题）。
 */
export function tokenIdOf(id: string): string {
  const name = customThemeName(id);
  return name === null ? id : `custom-${name}`;
}

/**
 * 解析清单串。`getPropertyValue` 拿到的是带引号的字面量（`"a,b,c"`），
 * 空清单是 `""`。顺带去空白、去重、丢掉不安全的 id——清单里混进一个坏名字，
 * 不该让整份清单不可用。
 */
export function parseThemeList(raw: string, toId: (s: string) => string = (s) => s): string[] {
  const inner = raw.trim().replace(/^["']|["']$/g, "");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of inner.split(",")) {
    if (!part.trim()) continue;
    const id = toId(part.trim());
    if (seen.has(id) || !isSafeThemeId(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * 同上，但清单里是**不带前缀的名字**（agent 的 `--ps-custom-themes` 就是这个形状：
 * 它列的是 keyDir 里的文件名），返回值是加好前缀的完整 id。
 * 分开一个函数是因为校验规则不同——自定义名放行大写、下划线与点，内置 id 不放行。
 */
export function parseCustomThemeList(raw: string): string[] {
  return parseThemeList(raw, customThemeId);
}

/**
 * 某套主题的明暗。来自清单里的 `--ps-scheme-<id>`（由生成器按背景色相对亮度判定）。
 * 读不到就回落 `"dark"`——jsdom 下没有 CSS，以及 agent 尚未供给自定义主题时都会走这里。
 */
export function schemeFromCss(id: string, read: CssReader): Scheme {
  return read(`--ps-scheme-${tokenIdOf(id)}`).trim() === "light" ? "light" : "dark";
}

/**
 * 某套自定义主题的**展示名**（原文件名）。
 *
 * 为什么要单独一个令牌：2026-08-05 之后 id 是文件名 slug 化的产物
 * （`Tokyo Night` → `tokyo-night`），清单里列的是 id，直接拿 id 当名字显示等于
 * 把用户的主题改了名。agent 每套多发一条 `--ps-name-custom-<id>: "Tokyo Night"`
 * （几十字节），设置面板显示它、id 只用于选择器与令牌名。
 *
 * 读不到就回落 id：老 agent、demo 站、以及 CSS 还没到位时都会走这条，显示一个
 * slug 总好过显示空白。
 */
export function nameFromCss(id: string, read: CssReader): string {
  const raw = read(`--ps-name-${tokenIdOf(id)}`).trim().replace(/^["']|["']$/g, "").trim();
  return raw || (customThemeName(id) ?? id);
}

/**
 * 某套主题的 5 个预览色。任一缺失返回 null（调用方据此画空色板而不是画错色板）。
 * 预览色住在无属性 `:root` 里，所以 A 主题激活时也读得到 B 主题的色——
 * 这正是它们存在的理由，否则设置面板里六行色板会画成一模一样。
 */
export function swatchFromCss(id: string, read: CssReader): string[] | null {
  const tid = tokenIdOf(id);
  const colors = SWATCH_SUFFIXES.map((s) => read(`--sw-${tid}-${s}`).trim());
  return colors.every((c) => c.length > 0) ? colors : null;
}

/** 一个没能成为主题的文件。`reason` 决定 UI 显示哪句话。 */
export interface ThemeSkip {
  file: string;
  reason: "name" | "dup" | "builtin" | "parse" | "read" | "internal";
}

const SKIP_REASONS = new Set(["name", "dup", "builtin", "parse", "read", "internal"]);

/**
 * 解析 agent 编进 CSS 的跳过清单（`"parse:a.ghostty,name:b c.ghostty"`）。
 *
 * 为什么跳过原因要走 CSS 而不是响应头：这份样式表是 `<link>` 拉的，而 `<link>`
 * 拿不到任何响应头。不塞进 CSS 里的话，「我把主题拷进去了但列表里没有」就是
 * 彻底静默的——而那恰好是这个功能最容易出的问题（编辑器备份文件、改了一半的
 * 配色、名字里带空格）。
 *
 * 认不出的条目直接丢：坏一条不该让整份提示消失，这与 agent 侧「一个坏文件只
 * 损失它自己」是同一条原则。
 */
export function parseSkips(raw: string): ThemeSkip[] {
  const inner = raw.trim().replace(/^["']|["']$/g, "");
  const out: ThemeSkip[] = [];
  for (const part of inner.split(",")) {
    const s = part.trim();
    if (!s) continue;
    const i = s.indexOf(":");
    if (i <= 0) continue;
    const reason = s.slice(0, i);
    const file = s.slice(i + 1).trim();
    if (!file || !SKIP_REASONS.has(reason)) continue;
    out.push({ file, reason: reason as ThemeSkip["reason"] });
  }
  return out;
}

/** 清单里的文件总数。读不到或不是数字时返回 0（视作「没有截断信息」）。 */
export function totalFromCss(read: CssReader): number {
  const n = Number(read(MANIFEST_TOTAL).trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** 是否触到上限。agent 明说了才算，读不到一律 false（宁可不提示也别误报）。 */
export function truncatedFromCss(read: CssReader): boolean {
  return read(MANIFEST_TRUNCATED).trim() === "1";
}
