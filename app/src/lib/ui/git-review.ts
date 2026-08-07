// 审查页的纯决策逻辑。组件只负责渲染，判据全在这里，便于单测。
import type { ReviewFile, ReviewScope } from "../net/protocol";

/**
 * 默认折叠阈值（add + del）。小改动直接展开、一屏读完；大文件折起来，
 * 折叠条本身就是"这里还有东西没看"的提醒。
 *
 * 折叠 ≠ oversize：折叠的数据在本地，点开即展开；oversize 是服务端
 * 压根没传正文，点了也没有。
 */
export const FOLD_THRESHOLD = 60;

/** 本就没有正文可展开的几类，一律按折叠处理（渲染成一条说明而非 hunk 列表）。 */
function hasNoBody(f: ReviewFile): boolean {
  return !!f.oversize || !!f.binary || !!f.isDir || f.status === "D";
}

export function shouldFold(f: ReviewFile): boolean {
  if (hasNoBody(f)) return true;
  return f.add + f.del > FOLD_THRESHOLD;
}

/**
 * 缓存 key。**每个语义维度都要进 key**：三档要互不串，切基线也必须重拉
 * （base 变了内容就完全不同）。
 *
 * `range` 的 base 可缺省（后端自行推断主干）。缺省态落到 `range:` 这个
 * 独立 key 上——它和任何具名基线都不同，因为「让后端推」这次推出什么
 * 前端并不知道，不能和某个具名基线共用缓存。
 */
export function reviewCacheKey(scope: ReviewScope): string {
  if (scope.kind === "commit") return `commit:${scope.hash}`;
  if (scope.kind === "range") return `range:${scope.base ?? ""}`;
  return `worktree:${scope.stage}`;
}

/**
 * 决定文件体渲染哪一个分支。**oversize 优先于 binary**：服务端两者都标时
 * （一个巨大的二进制文件），"内容过大"比"二进制"更贴近用户看到的原因。
 */
export function bodyState(f: ReviewFile): "hunks" | "oversize" | "binary" | "deleted" | "newdir" | "empty" {
  if (f.oversize) return "oversize";
  if (f.binary) return "binary";
  if (f.isDir) return "newdir";
  if (f.status === "D") return "deleted";
  if (f.hunks && f.hunks.length) return "hunks";
  return "empty";
}
