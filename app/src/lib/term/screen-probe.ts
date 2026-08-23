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
