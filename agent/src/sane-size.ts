// PTY 尺寸的合理性校验 —— 纵深防御的最后一道，也是唯一不可绕过的一道。
//
// 背景（12 期真机 bug）：客户端某一刻把 tmux 窗口 resize 成了约 12 列，Claude Code
// 的历史输出从此只占屏幕左侧一小块。取证确认窄排版**已烙进 tmux 自己的 scrollback**。
//
// 客户端根因已在 app/src/lib/term/fit-guard.ts 修掉（display:none 的元素
// getComputedStyle 返回声明值 "100%"，被 FitAddon 的 parseInt 当成 100 像素）。
// 这里再加一道的理由是**损坏不可逆**：
//
//   tmux 只能 reflow 它自己折的软折行。而 Claude Code 读 winsize 后自己算折行位置、
//   把 \n 打进输出流——那是硬换行。实测 `capture-pane -J` 也拼不回来。也就是说，
//   一次错误的 resize 会让上游程序按错误宽度**生成字节**，事后传回正确宽度也救不回。
//
// 既然一次失误就永久损坏用户的历史，就不能把正确性单独押在客户端上：任何版本的
// 客户端、任何未来的回归、任何第三方实现，都得过这一关。
//
// 取值语义是**丢弃而不是夹取**：夹到 20 列同样会让上游按 20 列硬折行、照样污染
// 历史，只是没那么难看；丢弃则能完整保住上一次的正确尺寸。宁可不改，也不改错。

/** 低于此值的尺寸一律视为客户端测量失败的产物，不是真实的窄屏。 */
export const MIN_COLS = 20;
export const MIN_ROWS = 4;

/** 高于此值的尺寸同样可疑（整数溢出 / 恶意帧），tmux 也无法真的用上。 */
export const MAX_COLS = 1000;
export const MAX_ROWS = 1000;

/**
 * 这个尺寸能不能拿去动 PTY / tmux 窗口。
 *
 * 实测到的塌陷值是 9~12 列，真机最窄的手机竖屏在最大字号下也远宽于 MIN_COLS，
 * 所以这条线能把「测量失败」与「真的很窄」分开。
 */
export function isSaneSize(cols: unknown, rows: unknown): boolean {
  return (
    typeof cols === "number" && typeof rows === "number" &&
    Number.isInteger(cols) && Number.isInteger(rows) &&
    cols >= MIN_COLS && cols <= MAX_COLS &&
    rows >= MIN_ROWS && rows <= MAX_ROWS
  );
}
