// git.review 的编排层：scope -> git 命令、基线推断、空仓库降级。
// 纯字符串解析在 git-review-parse.ts（可脱离真仓库单测）。
//
// 全部只读，spawn 系统 git（与终端、与 Claude 用同一个二进制，
// 面板和终端永远不会给出不同答案）。
import { runGit } from "./git-service";

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
