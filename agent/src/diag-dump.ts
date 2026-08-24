// 缺行原文转储 —— **本地取证专用，与 `[pocketshell:diag]` 日志是两回事**。
//
// 为什么需要它：对拍能告诉我们「有 27 行 tmux 有、xterm 没有」，能告诉我们它们
// 散在哪些行号，但**答不出「丢的是什么」**。而机制往往就写在内容本身上——是折行
// 的续行？是某类字符？是整段输出只落进去一部分？靠行号的形状猜了好几轮都没定论。
//
// 与诊断日志的边界（这条不能含糊）：
//   - `agent.out.log` 里的 `[pocketshell:diag]` 是**白名单制、只有计数**，用户可能
//     直接贴进公开 issue —— 那里永远不出现任何字符。
//   - 本文件写的是**会话原文**，只落在本机磁盘，绝不经由 rpc 上行、不进 agent.out.log、
//     也不该被贴出去。文件头写明了这一点。
//
// 因此它比诊断埋点多一道开关：`POCKETSHELL_DIAG` 打开**还不够**，必须额外显式打开
// `POCKETSHELL_DIAG_DUMP`。「查故障」与「把内容落盘」是两个不同量级的授权。

import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** 单次转储最多写多少行原文。取证够用即可，不必把整个窗口搬进文件。 */
export const DUMP_MAX_LINES = 60;

/** 文件体积上限。超过就不再追加 —— 排障文件不该把磁盘吃满。 */
export const DUMP_MAX_BYTES = 4 * 1024 * 1024;

export const DUMP_HEADER =
  "# PocketShell 缺行取证转储\n" +
  "# 本文件含**会话原文**，仅供本机排障，请勿贴进 issue 或分享。\n" +
  "# 由 POCKETSHELL_DIAG_DUMP=1 显式开启，删除本文件即可清空。\n";

export function dumpEnabled(env: Record<string, string | undefined>): boolean {
  const raw = env.POCKETSHELL_DIAG_DUMP;
  if (typeof raw !== "string" || raw === "") return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

export interface MissingDump {
  tag: string;
  ts: string;
  /** tmux 侧原始行（未滤空）。 */
  raw: string[];
  /** 缺行下标 —— **滤空之后**那个数组的下标，与 ScreenDiff.missingAt 同源。 */
  missingAt: number[];
}

/**
 * 把缺行连同上下各一行渲染成可读文本。
 *
 * 带上下文是关键：如果丢的是软折行的续行，它的**前一行**会是同一句话的前半段，
 * 一眼就能看出来；只看孤立的一行看不出这件事。
 *
 * 行首标记：`>` 缺失、` ` 上下文。行号同时给出 live 下标与原始行号，因为
 * missingAt 是 live 量纲、而人对着 capture-pane 的输出数的是原始行号。
 */
export function formatMissingDump(d: MissingDump): string {
  const live: { raw: number; text: string }[] = [];
  for (let i = 0; i < d.raw.length; i++) {
    if (d.raw[i].trim() !== "") live.push({ raw: i, text: d.raw[i] });
  }
  const missing = new Set(d.missingAt);
  const want = new Set<number>();
  for (const i of d.missingAt.slice(0, DUMP_MAX_LINES)) {
    for (const j of [i - 1, i, i + 1]) {
      if (j >= 0 && j < live.length) want.add(j);
    }
  }
  const idxs = [...want].sort((a, b) => a - b);

  const out: string[] = [
    `\n=== ${d.ts} ${d.tag} 缺 ${d.missingAt.length} 行 / live ${live.length} 行 ===`,
  ];
  let prev = -2;
  for (const i of idxs) {
    if (i !== prev + 1) out.push("  …");
    const mark = missing.has(i) ? ">" : " ";
    out.push(`${mark} live[${String(i).padStart(3)}] row[${String(live[i].raw).padStart(3)}] ${JSON.stringify(live[i].text)}`);
    prev = i;
  }
  if (d.missingAt.length > DUMP_MAX_LINES) {
    out.push(`  …（还有 ${d.missingAt.length - DUMP_MAX_LINES} 行未列出）`);
  }
  return out.join("\n") + "\n";
}

/** 追加一条转储。任何失败都吞掉 —— 取证文件写不进去不该影响会话。 */
export function appendMissingDump(path: string, d: MissingDump): void {
  try {
    let size = 0;
    let fresh = false;
    try {
      size = statSync(path).size;
    } catch {
      fresh = true;
    }
    if (size > DUMP_MAX_BYTES) return;
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, (fresh ? DUMP_HEADER : "") + formatMissingDump(d), "utf8");
  } catch { /* 排障文件写不进去就算了，不能反过来弄坏会话 */ }
}

/** 转储文件路径。与私钥同目录（`~/.pocketshell`），沿用 POCKETSHELL_KEY_DIR。 */
export function missingDumpPath(env: Record<string, string | undefined> = process.env): string {
  const dir = env.POCKETSHELL_KEY_DIR ?? join(homedir(), ".pocketshell");
  return join(dir, "diag-missing.txt");
}
