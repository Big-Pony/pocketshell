// R1 (hidden terminals): output that arrives while the terminal is inactive
// must not pay xterm's parse/render cost, so the raw bytes are stashed here
// and flushed as one concatenated write on activation. A hard cap bounds
// memory for chatty sessions: past the limit the stash is dropped and marked
// dirty, and activation reseeds from a full tmux snapshot instead of
// replaying a truncated byte stream.
//
// Lives in a plain .ts module rather than Terminal.svelte's `<script module>`:
// it is pure logic with no Svelte dependency, and tsc only ever sees the
// ambient `*.svelte` declaration (default export), so a named export from a
// component file is invisible to `tsc --noEmit`.
export class PendingBuffer {
  private chunks: Uint8Array[] = [];
  private seqs: number[] = [];
  private bytes = 0;
  private limit: number;
  dirty = false;

  constructor(limit = 2 * 1024 * 1024) {
    this.limit = limit;
  }

  /**
   * `seq` 是这批字节在服务端 replay 里的序号，**可选**：R1 的暂存路径不关心它，
   * 传不传都不影响既有行为（缺省 0 = 「没有序号信息」，永远不会被 takeAfter 滤掉）。
   *
   * 它是给重灌旁录用的，见 takeAfter。
   */
  push(data: Uint8Array, seq = 0): void {
    if (this.dirty) return;
    this.chunks.push(data);
    this.seqs.push(seq);
    this.bytes += data.byteLength;
    if (this.bytes > this.limit) {
      this.chunks = [];
      this.seqs = [];
      this.bytes = 0;
      this.dirty = true;
    }
  }

  // Concatenated pending bytes (buffer reset), or null when empty. Callers
  // must check `dirty` first — a dirty buffer keeps nothing to take.
  take(): Uint8Array | null {
    return this.takeAfter(0);
  }

  /**
   * 只取 seq **严格大于** `afterSeq` 的字节（缓冲照常清空），空则 null。
   *
   * 【2026-08-23 为什么需要它】重连出现 gap 时，服务端**先发 resync、再补发**最新
   * 32KB 实时字节（见 agent/src/replay.ts 的 GAP_BACKFILL_BUDGET_BYTES —— 那四个
   * 反例决定了补发不能取消）。客户端 onResync 是同步发起重灌，所以旁录窗口在补发
   * 帧到达**之前**就开好了，那 32KB 全部落进旁录。
   *
   * 而 `term.history` 是**先取号后快照**，返回的 seq 就是分界线：seq ≤ 它的字节
   * 已经在快照里了。旁录若把它们再拼到快照后面写一遍，屏幕上就是长串重复内容
   * ——真机症状「重连后出现长串重复」正是这么来的。
   *
   * 传 0（或用 take()）= 不过滤，保持 R1 暂存路径的原有语义。
   */
  takeAfter(afterSeq: number): Uint8Array | null {
    if (this.bytes === 0) return null;
    let total = 0;
    for (let i = 0; i < this.chunks.length; i++) {
      if (this.seqs[i] > afterSeq || this.seqs[i] === 0) total += this.chunks[i].byteLength;
    }
    const all = total > 0 ? new Uint8Array(total) : null;
    if (all) {
      let off = 0;
      for (let i = 0; i < this.chunks.length; i++) {
        if (this.seqs[i] > afterSeq || this.seqs[i] === 0) { all.set(this.chunks[i], off); off += this.chunks[i].byteLength; }
      }
    }
    this.chunks = [];
    this.seqs = [];
    this.bytes = 0;
    return all;
  }

  clearDirty(): void {
    this.dirty = false;
  }
}
