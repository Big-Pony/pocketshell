// 「屏幕对拍」——判定终端内容丢失到底发生在哪一层。
//
// 背景（docs/bug/终端显示异常2 与 2026-08-22 的排查）：症状是「终端中间少了
// 几行，上下文完好，重开会话就恢复」。这类故障有两种根子，修法完全相反：
//
//   A 数据真的没到 xterm 的 buffer（传输/背压/写入路径）
//   B buffer 里有，只是没画到屏幕上（WebGL 渲染器漏重画）
//
// 光看症状分不出来，而 2026-08-22 那轮排查里连着七个假设被推翻，代价就是每次
// 都要等下一次复现。对拍把这一刀切开：tmux 那边是**真值**（服务端 capture-pane
// 拿得到），xterm buffer 是客户端的实际状态，同一时刻比一次，
//
//   diffLines === 0  ⇒ buffer 与 tmux 一致 ⇒ 判 B，去查渲染器
//   diffLines  >  0  ⇒ buffer 真的少了内容 ⇒ 判 A，去查数据链路
//
// **隐私**：客户端只上传每行的哈希，不上传任何字符；agent 也只把行数与差异
// 位置写进日志。这条日志用户可能直接贴进公开 issue（见 diag-report.ts 的注释），
// 所以终端内容一个字节都不能进来。哈希是单向的，且逐行短文本本身不可逆推。

/** 行哈希：FNV-1a 32 位。够分辨「这两行不一样」，且两端实现都短到不会写错。 */
export function hashLine(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * 归一化一行再取哈希。两端必须做**完全一样**的归一，否则差异全是假的：
 *   - 去行尾空白：tmux capture-pane 补空格到 pane 宽度，xterm 的行是稀疏的；
 *   - 不去行首：行首空格是缩进，是真实内容的一部分，去掉会把不同的行看成同一行。
 */
export const normLine = (s: string): string => s.replace(/\s+$/, "");

export const hashLines = (lines: string[]): number[] => lines.map((l) => hashLine(normLine(l)));

/** 两端空白全去掉。必须与 app 侧 screen-probe.ts 的 normLineBare 逐字一致。 */
export const normLineBare = (s: string): string => s.replace(/^\s+/, "").replace(/\s+$/, "");

export const hashLinesBare = (lines: string[]): number[] =>
  lines.map((l) => hashLine(normLineBare(l)));

export interface ScreenDiff {
  tmuxLines: number;
  xtermLines: number;
  /** tmux 有、xterm 没有的行数 —— **这就是「屏幕上少了的内容」**。 */
  missingLines: number;
  /** xterm 有、tmux 没有的行数。陈旧内容（xterm 还留着已被覆盖的旧行）。 */
  extraLines: number;
  /** missing 里最靠上那行在 tmux 侧的行号；没有则 -1。 */
  firstDiff: number;
  /**
   * missing 各行在 tmux 侧的行号（最多 MISSING_AT_CAP 个）。
   *
   * 只有行号、没有任何字符 —— 日志可以贴进公开 issue，这条不能破。
   * 它要回答的问题是**缺行的分布形状**：
   *   - 挤在窗口末尾的连续一段 ⇒ 两侧窗口锚点错开，是比对假象；
   *   - 散落在中段 ⇒ 内容真的被穿插着丢了。
   * 光看 missingLines 计数区分不了这两种，firstDiff 也只给得出第一个。
   */
  missingAt: number[];
}

/** missingAt 的上限：够看出形状即可，不必把整窗行号搬进日志。 */
export const MISSING_AT_CAP = 40;

/**
 * 比对两份行哈希。
 *
 * 【2026-08-22 实测后重写】最初写的是「按位置逐行比」，上线第一条数据就是
 * diff=20/27 —— 全是假的。两个原因，都不是猜的：
 *
 *  1. **两个快照不是同一瞬间**。客户端取样 → rpc → agent 再 spawn 一次 tmux，
 *     中间隔一个 RTT（真机 1~3s）。而 Claude Code 的界面里有 spinner 动画、
 *     `13m 19s` 计时、token 计数，**每帧都在变**。实测同一 pane 相隔毫秒的两次
 *     capture-pane，就已经差在 spinner 字符上（`·` vs `✢`）。
 *  2. **行的划分方式两边不一定一致**。capture-pane 不带 `-J` 时按屏幕格导出、
 *     超出 pane 宽度的部分被硬截断；xterm 的 buffer 行则可能是 isWrapped 的续行。
 *     位置一旦错开一行，后面全部错位，diff 直接顶满。
 *
 * 所以判据改成**集合比对**：只问「tmux 有哪些行是 xterm 没有的」。
 *   - 位置无关 ⇒ 行划分差异、滚动偏移一格都不再制造假差异；
 *   - 动画行只会各自落进 missing/extra 各一条，不会放大成整屏；
 *   - 而真正的故障——「中间几行整体消失」——恰恰就是 missing 变大。
 *
 * 空行不参与：两边空行数量本来就不同（tmux 补白 vs xterm 稀疏），且空行消失
 * 不是可观察的故障。
 */
export function diffScreens(tmux: number[], xterm: number[]): ScreenDiff {
  const EMPTY = hashLine("");
  const live = (a: number[]) => a.filter((h) => h !== EMPTY);
  const t = live(tmux);
  const x = new Set(live(xterm));
  let missingLines = 0;
  let firstDiff = -1;
  const missingAt: number[] = [];
  for (let i = 0; i < t.length; i++) {
    if (!x.has(t[i])) {
      missingLines++;
      if (firstDiff < 0) firstDiff = i;
      if (missingAt.length < MISSING_AT_CAP) missingAt.push(i);
    }
  }
  const ts = new Set(t);
  let extraLines = 0;
  for (const h of live(xterm)) if (!ts.has(h)) extraLines++;
  return { tmuxLines: tmux.length, xtermLines: xterm.length, missingLines, extraLines, firstDiff, missingAt };
}
