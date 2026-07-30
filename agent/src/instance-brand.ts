// 实例身份：把部署时传入的 POCKETSHELL_INSTANCE_NAME 织进 PWA 的名称字段，
// 让同一份代码部署的多台服务器在手机桌面上可区分。纯函数、无 IO —— serve
// 层只负责在命中 /manifest.webmanifest 与 /index.html 时调用它们。
//
// 不设实例名时每个函数都原样返回输入（逐字节相同），因为现网 Mac mini 不设
// 此变量，任何漂移都是回归。

/** 名字之间的分隔符。改这里等于同时改 manifest.name、<title> 与顶栏。 */
const SEP = " · ";

/** 实例名上限。桌面图标下的文字远早于此就被系统截断，这个上限只防滥用。 */
const MAX_NAME = 32;

export interface Brand {
  /** 已归一化的实例名；空/未设表示不品牌化。 */
  name?: string;
}

/** 去空白、空串归一成 undefined、超长截断。env 与 agent.json 的入口都走它。 */
export function normalizeInstanceName(raw: string | undefined): string | undefined {
  const s = (raw ?? "").trim();
  if (!s) return undefined;
  return s.length > MAX_NAME ? s.slice(0, MAX_NAME) : s;
}

/** 「开发」+「PocketShell」→「开发 · PocketShell」；无实例名则原样返回 base。 */
export function displayName(instanceName: string | undefined, base: string): string {
  return instanceName ? `${instanceName}${SEP}${base}` : base;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * manifest 是结构化数据，走 JSON 解析而非正则改写（正则遇到转义/换行就脆）。
 * name 取带品牌后缀的完整式；short_name 只取实例名 —— 它是桌面图标下那行字，
 * 系统截断最狠，带后缀会被截成看不出区别的样子。
 */
export function brandManifest(raw: string, b: Brand): string {
  if (!b.name) return raw;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(raw);
  } catch {
    return raw; // serve 路径不能因为品牌化而挂掉
  }
  const base = typeof j.name === "string" ? j.name : "PocketShell";
  j.name = displayName(b.name, base);
  j.short_name = b.name;
  return JSON.stringify(j, null, 2);
}

/**
 * index.html 只改两处文字：<title> 与 apple-mobile-web-app-title。
 * icon 相关的 href 一律不碰（图标只有一套）。实例名是自由文本，注入前转义。
 */
export function brandHtml(raw: string, b: Brand): string {
  if (!b.name) return raw;
  const safe = escapeHtml(b.name);
  let out = raw.replace(
    /<title>([^<]*)<\/title>/,
    (_m, base: string) => `<title>${escapeHtml(displayName(b.name, base))}</title>`,
  );
  out = out.replace(
    /(<meta\s+name="apple-mobile-web-app-title"\s+content=")[^"]*(")/,
    (_m, pre: string, post: string) => `${pre}${safe}${post}`,
  );
  return out;
}
