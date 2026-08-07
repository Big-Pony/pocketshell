// git.review 的编排层：scope -> git 命令、基线推断、空仓库降级。
// 纯字符串解析在 git-review-parse.ts（可脱离真仓库单测）。
//
// 全部只读，spawn 系统 git（与终端、与 Claude 用同一个二进制，
// 面板和终端永远不会给出不同答案）。
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { runGit, isRepo } from "./git-service";
import {
  parseNumstat, parsePorcelain, stagedMark, splitDiffByFile, synthAddedHunk,
  planBudget, FILE_LINE_CAP, TOTAL_LINE_BUDGET, type DiffHunk,
} from "./git-review-parse";

export type ReviewScope =
  | { kind: "worktree"; stage: "all" | "staged" | "unstaged" }
  | { kind: "commit"; hash: string }
  | { kind: "range"; base: string };

/** 主干候选，按优先级。origin/HEAD 在 §3.1 由调用方先试，这里只管本地分支名。 */
const TRUNK_CANDIDATES = ["main", "master", "develop"];

/** HEAD 是否存在。空仓库（一次提交都没有）时 `git diff HEAD` 会直接报错。 */
export function hasHead(cwd: string): boolean {
  return runGit(cwd, ["rev-parse", "--verify", "-q", "HEAD"]).ok;
}

/**
 * scope -> 两条 git 命令（numstat 拿清单、body 拿正文）。
 *
 * 返回 null 表示"这个组合在当前仓库状态下无意义"，调用方回空结果而非报错
 * ——空仓库的 unstaged 档就是这种情况。
 *
 * range 用 `base...HEAD`（三点）而非 `base HEAD`（两点）：三点等价于
 * "相对分叉点"，主干后续推进不会把别人的提交混进你的对比里。
 *
 * **不需要额外 spawn `git merge-base`**：`git diff A...B` 的定义就是
 * `git diff $(git merge-base A B) B`，git 内部算好了。手动先算一次
 * merge-base 再 diff，结果一模一样却多一次 spawn（破坏「spawn 次数与
 * 规模无关」）。spec §3.1 说的"merge-base"指的就是这个语义，不是要你
 * 真的去调那个命令。
 */
export function diffArgs(
  scope: ReviewScope, hasHeadRef: boolean,
): { numstat: string[]; body: string[] } | null {
  const R = "--find-renames";
  const pair = (base: string[]) => ({ numstat: [...base, "--numstat", R], body: [...base, R] });

  if (scope.kind === "commit") {
    return {
      numstat: ["show", scope.hash, "--numstat", "--format=", R],
      body: ["show", scope.hash, "--format=", R],
    };
  }
  if (scope.kind === "range") return pair(["diff", `${scope.base}...HEAD`]);

  // worktree
  if (!hasHeadRef) {
    // 没有 HEAD 就没有"相对上次提交"这个参照：all 与 staged 退化为
    // "相对空树"（即 --cached），unstaged 无从谈起。
    if (scope.stage === "unstaged") return null;
    return pair(["diff", "--cached"]);
  }
  if (scope.stage === "staged") return pair(["diff", "--cached"]);
  if (scope.stage === "unstaged") return pair(["diff"]);
  return pair(["diff", "HEAD"]);
}

/**
 * 推断主干分支名。依次试 origin/HEAD -> main -> master -> develop，
 * 取第一个真实存在的 ref。全都没有就 throw——与其猜一个错的基线让用户
 * 看到一堆不是自己写的改动，不如让 UI 弹分支列表请他手选。
 */
export function inferBaseline(cwd: string): string {
  const originHead = runGit(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (originHead.ok) {
    const name = originHead.stdout.trim();
    if (name) return name;
  }
  for (const b of TRUNK_CANDIDATES) {
    if (runGit(cwd, ["rev-parse", "--verify", "-q", b]).ok) return b;
  }
  throw new Error("no_baseline");
}

export interface ReviewFile {
  path: string;
  status: "M" | "A" | "D" | "R" | "?";
  add: number;
  del: number;
  staged?: "full" | "partial";
  oversize?: true;
  binary?: true;
  isDir?: true;
  hunks?: DiffHunk[];
}

export interface ReviewResult {
  scope: ReviewScope;
  title: string;
  subtitle: string;
  files: ReviewFile[];
  totals: { files: number; add: number; del: number };
  truncated?: true;
  counts?: { all: number; staged: number; unstaged: number };
  baseline?: { base: string; inferred: boolean };
}

/** 未跟踪文件正文的读取上限（字节）。超过就不读——UI 反正也只显示 cap 行。 */
const UNTRACKED_READ_BYTES = 512 * 1024;

/**
 * 一次审查 = 至多 5 次 spawn，且**与文件数、diff 大小无关**：
 *   isRepo + hasHead + numstat + body + status（未跟踪补录）
 * 未跟踪文件的正文走 readFileSync 而非 git（见 synthAddedHunk 的注释）。
 */
export function gitReview(cwd: string, scope: ReviewScope): ReviewResult {
  if (!isRepo(cwd)) throw new Error("not_a_repo");

  const headExists = scope.kind === "worktree" ? hasHead(cwd) : true;
  const args = diffArgs(scope, headExists);

  // numstat + body
  let numstatOut = "", bodyOut = "";
  if (args) {
    const ns = runGit(cwd, args.numstat);
    if (!ns.ok) throw new Error(revisionError(scope, ns.stderr));
    numstatOut = ns.stdout;
    const bd = runGit(cwd, args.body);
    if (!bd.ok) throw new Error(revisionError(scope, bd.stderr));
    bodyOut = bd.stdout;
  }

  const rows = parseNumstat(numstatOut);
  const hunkMap = splitDiffByFile(bodyOut);

  // 工作区范围需要 porcelain：拿暂存标记 + 补录未跟踪条目
  const wantStatus = scope.kind === "worktree";
  const porcelain = wantStatus ? parsePorcelain(runGit(cwd, ["status", "--porcelain"]).stdout) : [];
  const pByPath = new Map(porcelain.map((p) => [p.path, p]));

  const files: ReviewFile[] = [];

  // 1) 有 numstat 的（被 git diff 覆盖到的）
  for (const r of rows) {
    const p = pByPath.get(r.path);
    files.push({
      path: r.path,
      status: statusOf(r.path, p, hunkMap),
      add: r.add,
      del: r.del,
      ...(r.binary ? { binary: true as const } : {}),
      ...(p && wantStatus ? withStaged(p.x, p.y) : {}),
    });
  }

  // 2) 未跟踪条目（git diff 看不到，需从 porcelain 补）
  if (wantStatus && scope.stage !== "staged") {
    for (const p of porcelain) {
      if (p.x !== "?") continue;
      if (p.isDir) { files.push({ path: p.path, status: "?", add: 0, del: 0, isDir: true }); continue; }
      const abs = join(cwd, p.path);
      const read = readUntracked(abs);
      files.push({
        path: p.path, status: "?", add: read.add, del: 0,
        ...(read.binary ? { binary: true as const } : {}),
      });
    }
  }

  // 3) 预算装填 -> 决定谁带正文
  const { keep, truncated } = planBudget(files, TOTAL_LINE_BUDGET, FILE_LINE_CAP);
  for (const f of files) {
    if (f.isDir || f.binary || f.status === "D") continue;  // 这三类本就不传正文
    if (!keep.has(f.path)) { f.oversize = true; continue; }
    f.hunks = hunkMap.get(f.path) ?? untrackedHunks(cwd, f);
  }

  return {
    scope,
    title: titleOf(cwd, scope),
    subtitle: subtitleOf(cwd, scope),
    files,
    totals: {
      files: files.length,
      add: files.reduce((s, f) => s + f.add, 0),
      del: files.reduce((s, f) => s + f.del, 0),
    },
    ...(truncated ? { truncated: true as const } : {}),
    ...(wantStatus ? { counts: countsOf(porcelain) } : {}),
    ...(scope.kind === "range" ? { baseline: { base: scope.base, inferred: true } } : {}),
  };
}

function withStaged(x: string, y: string) {
  const m = stagedMark(x, y);
  return m ? { staged: m } : {};
}

function statusOf(path: string, p: { x: string; y: string } | undefined, hunks: Map<string, DiffHunk[]>): ReviewFile["status"] {
  if (p) {
    for (const ch of [p.x, p.y]) {
      if (ch === "D") return "D";
      if (ch === "A") return "A";
      if (ch === "R") return "R";
      if (ch === "M") return "M";
      if (ch === "?") return "?";
    }
  }
  // commit / range 范围没有 porcelain，从 diff 正文的存在性推断
  return hunks.has(path) ? "M" : "M";
}

function readUntracked(abs: string): { add: number; binary: boolean } {
  try {
    if (statSync(abs).size > UNTRACKED_READ_BYTES) return { add: 0, binary: false };
    const buf = readFileSync(abs);
    if (buf.subarray(0, Math.min(buf.length, 8192)).includes(0)) return { add: 0, binary: true };
    const s = synthAddedHunk(buf.toString("utf8"), FILE_LINE_CAP);
    return { add: s.add, binary: false };
  } catch { return { add: 0, binary: false }; }
}

function untrackedHunks(cwd: string, f: ReviewFile): DiffHunk[] | undefined {
  if (f.status !== "?") return undefined;
  try {
    const buf = readFileSync(join(cwd, f.path));
    if (buf.subarray(0, Math.min(buf.length, 8192)).includes(0)) return undefined;
    return synthAddedHunk(buf.toString("utf8"), FILE_LINE_CAP).hunks;
  } catch { return undefined; }
}

function countsOf(rows: { x: string; y: string; isDir: boolean }[]) {
  let staged = 0, unstaged = 0;
  for (const r of rows) {
    if (r.x !== " " && r.x !== "?" && r.x !== "") staged++;
    if ((r.y !== " " && r.y !== "") || r.x === "?") unstaged++;
  }
  return { all: rows.length, staged, unstaged };
}

function revisionError(scope: ReviewScope, stderr: string): string {
  if (scope.kind === "commit") return "bad_revision";
  if (scope.kind === "range") return "bad_revision";
  return stderr.trim().split("\n")[0] || "git_failed";
}

function titleOf(cwd: string, scope: ReviewScope): string {
  if (scope.kind === "commit") {
    const s = runGit(cwd, ["show", "-s", "--format=%h %s", scope.hash]);
    return s.ok ? s.stdout.trim() : scope.hash;
  }
  if (scope.kind === "range") {
    const cur = runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
    return `${cur} → ${scope.base}`;
  }
  return "";   // 工作区标题由前端 i18n 给（「全部改动」），后端不塞中文
}

function subtitleOf(cwd: string, scope: ReviewScope): string {
  if (scope.kind === "commit") {
    const s = runGit(cwd, ["show", "-s", "--format=%an · %ad", "--date=relative", scope.hash]);
    return s.ok ? s.stdout.trim() : "";
  }
  return "";   // 其余由前端 i18n 组装
}
