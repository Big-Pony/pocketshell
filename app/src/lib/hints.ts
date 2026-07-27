// app/src/lib/hints.ts
// 需求 5：用户自定义输入联想库的纯逻辑。存储在后端（hint-store），这里只负责
// 归类、与内置清单去重、AI 提示词生成、粘贴内容解析——全是纯函数，好测。
import { CATALOG } from "./command-catalog";
import { SLASH_CATALOG } from "./slash-catalog";

export const HINT_MAX_LEN = 200;
export const HINT_MAX_BATCH = 500;

/** 内置的 shell + slash 全集，用于入库前去重。与服务端限额无关。 */
export const ALL_BUILTINS: Set<string> = new Set([...CATALOG, ...SLASH_CATALOG]);

/** 以 "/" 开头 = Claude Code / Codex 斜杠命令，与 App 的分支判据一致。 */
export function isSlashHint(text: string): boolean {
  return text.startsWith("/");
}

/** 把自定义条目分成 shell / slash 两池，分别喂给 suggest / suggestSlash。 */
export function splitPools(texts: string[]): { shell: string[]; slash: string[] } {
  const shell: string[] = [];
  const slash: string[] = [];
  for (const t of texts) (isSlashHint(t) ? slash : shell).push(t);
  return { shell, slash };
}

/**
 * 丢掉与内置清单重复的条目。
 *
 * 精确字符串匹配，**不做 trim** —— 内置表里 "git add "（尾空格 = 待补参数）
 * 与 "git add"（直接可执行）插入行为不同，是两条不同的条目。用户添加
 * "git add" 不算与内置 "git add " 重复。这是有意为之，勿改成 trim 比较。
 */
export function filterAgainstBuiltins(
  texts: string[], builtins: Set<string>,
): { ok: string[]; builtinHits: number } {
  const ok: string[] = [];
  let builtinHits = 0;
  for (const t of texts) {
    if (builtins.has(t)) builtinHits++;
    else ok.push(t);
  }
  return { ok, builtinHits };
}

/** 剥掉一行外围的列表符号、成对引号、行尾逗号。 */
function cleanLine(line: string): string {
  let s = line.trim();
  s = s.replace(/^[-*]\s+/, "");        // markdown 列表符号
  s = s.replace(/,\s*$/, "");           // 行尾逗号（JSON 残片）
  const quoted = /^"(.*)"$/.exec(s) ?? /^'(.*)'$/.exec(s);
  if (quoted) s = quoted[1];
  return s.trim();
}

/**
 * 解析用户粘贴的内容。先试严格 JSON 数组；失败则按行回退——AI 极常裹一层
 * ```json 代码围栏或直接给几行裸文本，只认 JSON 会整批失败且用户不知道原因。
 */
export function parseHintImport(
  raw: string,
): { ok: string[]; skippedLong: number; skippedDup: number; error?: string } {
  const empty = { ok: [] as string[], skippedLong: 0, skippedDup: 0 };
  const stripped = raw.trim().replace(/^```[a-zA-Z]*\s*/, "").replace(/```\s*$/, "").trim();
  if (!stripped) return { ...empty, error: "empty" };

  let candidates: string[] | null = null;
  try {
    const parsed = JSON.parse(stripped);
    if (Array.isArray(parsed)) candidates = parsed.filter((x): x is string => typeof x === "string");
  } catch { /* 落到按行回退 */ }

  if (!candidates) {
    candidates = stripped.split("\n").map(cleanLine).filter((s) => s.length > 0);
  }
  if (candidates.length === 0) return { ...empty, error: "empty" };

  const seen = new Set<string>();
  const ok: string[] = [];
  let skippedLong = 0;
  let skippedDup = 0;
  for (const c of candidates) {
    if (c.length > HINT_MAX_LEN) { skippedLong++; continue; }
    if (seen.has(c)) { skippedDup++; continue; }
    seen.add(c);
    ok.push(c);
  }
  return { ok, skippedLong, skippedDup };
}

/**
 * 生成发给 AI 的提示词。带上内置清单让 AI 一开始就不产重复，比事后跳过体验好
 * （约 600 字符，成本可忽略）。
 */
export function buildHintPrompt(existing: string[], builtins: string[]): string {
  return [
    "我在用 PocketShell（手机终端 App）。请帮我生成一批命令联想条目，",
    "输出「仅一个 JSON 数组」，每个元素是一个字符串，不要任何解释文字。",
    "",
    "规则：",
    "- 每条是一个可直接执行的命令或命令前缀",
    '- 需要跟参数的命令，末尾留一个空格，如 "git checkout "',
    "- 以 / 开头的会被识别为 Claude Code / Codex 斜杠命令",
    `- 单条不超过 ${HINT_MAX_LEN} 字符，总数不超过 ${HINT_MAX_BATCH} 条`,
    "",
    "已内置（不要生成）：",
    JSON.stringify(builtins),
    "",
    "我已添加的（不要重复）：",
    JSON.stringify(existing),
  ].join("\n");
}
