// Git 面板分支列表的排序与截断（13 期需求 3）。
// 分支多的仓库全量平铺会糊成一大片 chip，默认只露前几个，其余折叠。

/** 折叠态默认展示的分支数。 */
export const BRANCH_LIMIT = 5;

/**
 * 当前分支置顶，其余保持 git 返回的原顺序。
 *
 * 不做二次排序：后端 `git branch --format=%(refname:short)` 已按字母序返回，
 * 前端再排一遍只会让「面板里的顺序」和「终端里 git branch 的顺序」对不上。
 * current 不在列表里时（detached HEAD 等）原样返回，不硬塞进去。
 */
export function orderBranches(current: string, all: string[]): string[] {
  if (!current || !all.includes(current)) return all;
  return [current, ...all.filter((b) => b !== current)];
}

/** expanded 为真返回全部，否则取前 limit 个。 */
export function visibleBranches(ordered: string[], expanded: boolean, limit = BRANCH_LIMIT): string[] {
  return expanded ? ordered : ordered.slice(0, limit);
}
