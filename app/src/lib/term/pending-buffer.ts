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

  /**
   * 丢掉 seq **小于等于** `afterSeq` 的字节，其余原序保留（缓冲不清空）。
   *
   * 【2026-08-27 为什么需要它】隐藏的 tab 把实时字节攒在这里（R1），而 resync
   * 触发的重灌**不看可见性** —— 它照样把 RIS + 整份 tmux 快照写进 xterm。快照
   * 拍的是 tmux 此刻的画面，攒着的那批字节早已体现在里面了。等用户切回来，
   * flushPending 再把它们整份重放一遍，落到一份已是终态的 buffer 上：Claude Code
   * 的增量重绘流（`\r` / 光标上移 / 擦行）一边重复一边覆盖，用户看到的就是
   * 「AI 最后一次的输出不见了」。真机 teachppt 那次是 104,599 字节压上去。
   *
   * `term.history` 是**先取号后快照**，返回的 seq 就是分界线（同 takeAfter）。
   * 快照一落地就在这里把分界线以前的积压丢掉，而不是等 flush 时再过滤：积压
   * 有 2MB 上限，留着它们会把长时间隐藏的会话推向 dirty，白白多一次重灌。
   *
   * seq 为 0 = 「没有序号信息」，一律保留（同 takeAfter 的语义）。
   */
  dropUpTo(afterSeq: number): void {
    if (!Number.isFinite(afterSeq) || afterSeq <= 0 || this.bytes === 0) return;
    const chunks: Uint8Array[] = [];
    const seqs: number[] = [];
    let bytes = 0;
    for (let i = 0; i < this.chunks.length; i++) {
      const seq = this.seqs[i];
      if (seq > afterSeq || seq === 0) {
        chunks.push(this.chunks[i]);
        seqs.push(seq);
        bytes += this.chunks[i].byteLength;
      }
    }
    this.chunks = chunks;
    this.seqs = seqs;
    this.bytes = bytes;
  }

  clearDirty(): void {
    this.dirty = false;
  }
}
