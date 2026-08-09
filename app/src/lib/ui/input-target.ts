// 键盘 / 输入法缓冲 / 片段面板发出的文本，该打进哪个会话。
//
// 为什么需要这个函数（2026-08-09 真机 bug）：App.svelte 里有两个「当前」——
//   - activeTopId 决定**渲染**哪个 tab（`active={activeTopId === s.name}`）
//   - activeId    曾经决定**发往**哪个会话（`conn.sendInput(activeId, ...)`）
// 切终端时 selectTop → selectSession 会同步两者，但切到**文件 tab** 时只设
// activeTop、不动 activeId（selectTop / openFile / closeFile 三处都能造成分叉）。
// 结果是在文件 tab 上用输入法发送，文本静默打进了上一个终端。
//
// 修法是让发送端**只认聚焦的那个 tab**：眼睛看到哪个，键盘就打到哪个；
// 看到的不是终端，就哪儿都不打。
//
// 刻意只收 activeTopId 一个参数、不留 activeId 兜底：activeTopId 自己的派生
// 式（App.svelte 的 `activeTop && topOrder.includes(activeTop) ? activeTop :
// (activeId || topOrder[0] || "")`）里已经把 activeId 当过一次兜底了，再收一个
// 就是把刚拆掉的分叉又请回来。
export const FILE_TAB_PREFIX = "file:";

/**
 * @param activeTopId 当前聚焦的 top tab id（终端是会话名，文件是 "file:*"）
 * @returns 该收这段输入的会话名；null = 不该发给任何会话
 */
export function inputTarget(activeTopId: string): string | null {
  // 聚焦在文件预览/编辑器上：输入不属于任何终端。返回 null 而不是回退到别处 ——
  // 回退正是这条 bug 的成因。打进看不见的终端比什么都不做更糟：用户看不到
  // 反馈，而那个终端可能正跑着别的东西。
  if (activeTopId.startsWith(FILE_TAB_PREFIX)) return null;
  return activeTopId || null;
}
