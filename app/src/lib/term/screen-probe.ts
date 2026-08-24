// 屏幕对拍的客户端侧：把 xterm **可视区**的每一行取出来、哈希、交给 agent 与
// tmux 真值比对。判定逻辑与隐私约束见 agent/src/screen-diff.ts 的文件头。
//
// 这里只做两件事：正确地取到「屏幕上此刻显示的那些行」，以及用与 agent 逐字
// 相同的方式归一 + 哈希。两端归一不一致的话差异全是假的，所以 normLine/hashLine
// 在这里是**照抄**（而不是 import）——app 不依赖 agent 的源码树，两处各有单测，
// app/src/lib/term/screen-probe.test.ts 里有一组固定向量钉住两边一致。

/** FNV-1a 32 位。必须与 agent/src/screen-diff.ts 的 hashLine 逐字一致。 */
export function hashLine(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 去行尾空白，保留行首缩进。必须与 agent 侧的 normLine 逐字一致。 */
export const normLine = (s: string): string => s.replace(/\s+$/, "");

interface BufferLineLike { translateToString(trimRight?: boolean): string }
interface BufferLike {
  readonly viewportY: number;
  /** 滚到底时的首行。它之上是已沉降的 scrollback —— 见 bufferTailLines。 */
  readonly baseY: number;
  readonly length: number;
  getLine(y: number): BufferLineLike | undefined;
}
interface TermLike {
  readonly rows: number;
  readonly buffer: { readonly active: BufferLike };
}

/**
 * 取当前**视口**内的行文本。
 *
 * 用 `viewportY` 而不是 `baseY`：前者是「屏幕上正在显示的第一行」，后者是「滚到
 * 底时的第一行」。用户往上滚过之后两者不等，用 baseY 会拿到底部那一屏、与屏幕
 * 上看到的不是同一块，对拍就永远对不上。
 *
 * 越界行取空串而不是跳过：行号必须与视口位置一一对应，跳过会让后面的行整体上移，
 * 底部对齐失效。
 */
export function viewportLines(term: TermLike): string[] {
  const buf = term.buffer.active;
  const top = buf.viewportY;
  const out: string[] = [];
  for (let i = 0; i < term.rows; i++) {
    const line = buf.getLine(top + i);
    out.push(line ? line.translateToString(true) : "");
  }
  return out;
}

export const hashViewport = (term: TermLike): number[] =>
  viewportLines(term).map((l) => hashLine(normLine(l)));

/**
 * 已沉降的 scrollback 的最后 `n` 行（**不含当前屏**）。
 *
 * 【2026-08-24 为什么需要它】视口对拍只哈希屏上那 27 行，而「往上翻才发现少了
 * 一段」的丢失全都发生在 scrollback 里 —— 两边看的都不是出事的地方，所以视口
 * 对拍一路报 missingLines=0。今天已经因为这个盲区两次把「没有证据」当成
 * 「没有问题」：一次是重灌截断 scrollback（v1.19.5 才修掉），一次是本条。
 *
 * 取 `0..baseY-1` 而不是整个 buffer：baseY 是「滚到底时的首行」，它之上就是
 * 已经沉降的历史。当前屏被排除是刻意的 —— 那里有 CC 的 spinner/计时器逐帧在变，
 * 拿它对拍必然假阳（视口对拍为此专门做了两次确认与配对抵扣，这里直接绕开）。
 */
export function bufferTailLines(term: TermLike, n: number): string[] {
  const buf = term.buffer.active;
  const end = buf.baseY;            // 不含：baseY 起就是当前屏
  const start = Math.max(0, end - n);
  const out: string[] = [];
  for (let i = start; i < end; i++) {
    const line = buf.getLine(i);
    out.push(line ? line.translateToString(true) : "");
  }
  return out;
}

export const hashBufferTail = (term: TermLike, n: number): number[] =>
  bufferTailLines(term, n).map((l) => hashLine(normLine(l)));

/**
 * 只留可见字符的归一：两端空白全去掉。必须与 agent 侧的 normLineBare 逐字一致。
 *
 * 它存在的唯一目的是**把「行真的没了」与「行还在、只是缩进对不上」分开**。
 * normLine 保留行首缩进，所以缩进差一格就会让集合比对同时报 missing 和 extra
 * ——那和整行丢失的指纹长得一模一样。用两端都去掉空白的哈希再比一次：
 *   - 两次都缺 ⇒ 内容真的不在 buffer 里；
 *   - 只有严归一那次缺 ⇒ 字是在的，差的是空白，不是丢内容。
 */
export const normLineBare = (s: string): string => s.replace(/^\s+/, "").replace(/\s+$/, "");

export const hashBufferTailBare = (term: TermLike, n: number): number[] =>
  bufferTailLines(term, n).map((l) => hashLine(normLineBare(l)));
