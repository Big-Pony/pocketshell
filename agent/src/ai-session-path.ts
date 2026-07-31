// 各 AI CLI 会话落盘文件的定位与尾部读取。
//
// 设计原则：
// - 路径规则集中在这里，调用方（notify/statusline 子命令）只关心 readTail(tool, cwd, sessionId)。
// - 只读尾部 64KB：这些 jsonl 可达数十 MB，全量读取会打爆 agent 内存。
// - 失败/不存在时返回空串而不是抛错——解析失败即不显示 token，不会打扰用户。

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { AiTool } from "./ai-context";

const TAIL_BYTES = 64 * 1024;

function homeDir(): string { return process.env.HOME || homedir(); }

export function kimiSessionPath(cwd: string, sessionId: string): string {
  const md5 = createHash("md5").update(cwd).digest("hex");
  return join(homeDir(), ".kimi", "sessions", md5, sessionId, "wire.jsonl");
}

export function claudeSessionPath(cwd: string, sessionId: string): string {
  // Claude Code 的 transcript 里没有窗口大小，分子由 assistant 记录取，
  // 总量由 statusLine 提供。
  //
  // slug 规则来自本机 ~/.claude/projects/ 的实际目录名，四点都是硬要求：
  //   1) 分隔符是 `-` 不是 `_`；
  //   2) 保留开头那个分隔符（"/Volumes/x" → "-Volumes-x"），不能 strip；
  //   3) 不截断——本机存在 73 字符的目录名；
  //   4) 点号等非字母数字字符同样变 `-`（".claude" → "-claude"，故
  //      worktree 路径里会出现连续两个 `-`）。实测：真实目录名的字符集
  //      只有字母、数字和 `-`。
  // 实测样本：
  //   /Volumes/ssd/document/project/phone-term
  //     → -Volumes-ssd-document-project-phone-term
  //   /Volumes/ssd/document/project/phone-term/.claude/worktrees/notify-feature
  //     → -Volumes-ssd-document-project-phone-term--claude-worktrees-notify-feature
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return join(homeDir(), ".claude", "projects", slug, `${sessionId}.jsonl`);
}

function codexSessionsBase(): string {
  return join(homeDir(), ".codex", "sessions");
}

// 按 mtime 从新到旧列出 base 下所有 .jsonl（codex 按 YYYY/MM/DD 建子目录）。
function jsonlFilesByMtimeDesc(base: string): string[] {
  if (!existsSync(base)) return [];
  const found: { path: string; mtime: number }[] = [];
  const scanDir = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      try {
        const s = statSync(full);
        if (s.isDirectory()) { scanDir(full); continue; }
        if (!entry.endsWith(".jsonl")) continue;
        found.push({ path: full, mtime: s.mtimeMs });
      } catch { /* skip entries we can't stat */ }
    }
  };
  scanDir(base);
  return found.sort((a, b) => b.mtime - a.mtime).map((f) => f.path);
}

// rollout 文件首行是 session_meta，带着这个会话的 cwd。读首行即可判断归属，
// 不必读整个文件（这些文件可达数百 MB）。
function rolloutCwd(path: string): string | null {
  try {
    // 首行通常远小于 8KB；读一小段再按换行切，避免整文件加载。
    const head = readFileSync(path, { encoding: "utf8", flag: "r" }).slice(0, 8192);
    const firstLine = head.split("\n", 1)[0];
    const j = JSON.parse(firstLine);
    const cwd = j?.payload?.cwd ?? j?.cwd;
    return typeof cwd === "string" ? cwd : null;
  } catch { return null; }
}

export function codexSessionPath(cwd: string, _sessionId: string): string | null {
  // codex 的目录按 YYYY/MM/DD 组织，文件名是 rollout-<时间戳>-<uuid>.jsonl。
  //
  // 不能简单取「全局 mtime 最新」：两个项目并行跑 codex 时，A 的 hook 触发
  // 那一刻若 B 刚写过文件，就会把 B 的 token 数显示到 A 的分割条上。
  // rollout 首行的 session_meta 带着 cwd，用它过滤出属于本会话的文件。
  //
  // 注意不用 sessionId 匹配文件名：hook 传来的 session_id 与 rollout 文件名
  // 里嵌的 UUID 未经证实是同一个（本机未装 codex，无法验证），而 cwd 是
  // 文档明确记载的字段。cwd 命中不了时回落到最新文件——单项目场景下这仍
  // 是对的，多项目场景下至少不会比原来更差。
  const files = jsonlFilesByMtimeDesc(codexSessionsBase());
  if (files.length === 0) return null;
  for (const f of files) {
    if (rolloutCwd(f) === cwd) return f;
  }
  return files[0];
}

function resolvePath(tool: AiTool, cwd: string, sessionId: string): string | null {
  switch (tool) {
    case "kimi": return kimiSessionPath(cwd, sessionId);
    case "claude": return claudeSessionPath(cwd, sessionId);
    case "codex": return codexSessionPath(cwd, sessionId);
    case "opencode": return null;
  }
}

async function readFileTail(path: string, bytes: number): Promise<string> {
  if (!existsSync(path)) return "";
  const file = Bun.file(path);
  const size = file.size;
  if (size === 0) return "";
  const start = Math.max(0, size - bytes);
  const slice = file.slice(start, size);
  const buf = await slice.bytes();
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

/** 读取指定工具会话文件的尾部文本。文件不存在或读失败时返回空串。 */
export async function readTail(tool: AiTool, cwd: string, sessionId: string): Promise<string> {
  const path = resolvePath(tool, cwd, sessionId);
  if (!path) return "";
  try { return await readFileTail(path, TAIL_BYTES); } catch { return ""; }
}
