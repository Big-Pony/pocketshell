// WP-6: reassembly of chunked rpc responses. When the full `response` frame
// exceeds the server's single-frame size cap, it arrives as rpcChunk frames
// ({id, index, total, bytes=raw slice of the response JSON bytes}); small
// responses still arrive as one `response` frame. This is the pure,
// unit-testable half — Connection wires it to the rpc pending map and gives
// the buffers the exact same lifetime as a pending rpc (timeout / disconnect
// / settle all drop them).
//
// 二进制化（rpc 二进制帧编码批）后 frame.bytes 是裸字节（来自二进制帧的
// blob，或旧 JSON 帧在 dispatch() 里先 fromB64 转好），不会再解码失败，
// 所以本模块不含 base64 逻辑、也没有 bad_data 错误分支。
// Hard cap on chunks per response: a sane upper bound far above any real
// response (server slices ~60KB, so 10000 chunks ≈ 600MB). Garbage totals
// beyond this would only ever come from a corrupt peer — refuse to allocate.
export const MAX_CHUNKS = 10000;

export interface ChunkFrame {
  id: string;
  index: number;
  total: number;
  bytes: Uint8Array;
}

export type FeedResult =
  | { status: "pending" }
  | { status: "done"; bytes: Uint8Array }
  | { status: "error"; reason: string };

export class ChunkReassembler {
  private buffers = new Map<string, { total: number; parts: (Uint8Array | undefined)[]; received: number }>();

  has(id: string): boolean {
    return this.buffers.has(id);
  }

  drop(id: string): void {
    this.buffers.delete(id);
  }

  clear(): void {
    this.buffers.clear();
  }

  // Feed one rpcChunk frame. WS is ordered and the server sends chunks
  // contiguously, but out-of-order arrival is tolerated (buffered by index);
  // anything structurally impossible (bad total, out-of-range index, changing
  // total) is an immediate error so the caller can reject the rpc instead of
  // waiting out the 10s timeout.
  feed(frame: ChunkFrame): FeedResult {
    const { id, index, total } = frame;
    if (!Number.isInteger(total) || total <= 0 || total > MAX_CHUNKS) {
      return { status: "error", reason: "bad_total" };
    }
    if (!Number.isInteger(index) || index < 0 || index >= total) {
      return { status: "error", reason: "bad_index" };
    }
    let buf = this.buffers.get(id);
    if (!buf) {
      buf = { total, parts: new Array(total).fill(undefined), received: 0 };
      this.buffers.set(id, buf);
    } else if (buf.total !== total) {
      return { status: "error", reason: "total_mismatch" };
    }
    if (buf.parts[index] !== undefined) return { status: "pending" }; // duplicate: ignore
    // slice() 是必须的真拷贝：frame.bytes 是 unpackBinFrame 返回的零拷贝视图，
    // 持有**整帧**的底层 buffer。分片要驻留到全部到齐，不拷贝的话每个分片都
    // 钉住一整帧不让回收，内存放大到分片数倍。
    //
    // （二进制化后 bad_data 分支已删除——字节不会解码失败，而 base64 会。）
    buf.parts[index] = frame.bytes.slice();
    buf.received++;
    if (buf.received < buf.total) return { status: "pending" };
    let size = 0;
    for (const p of buf.parts) size += p!.length;
    const out = new Uint8Array(size);
    let off = 0;
    for (const p of buf.parts) { out.set(p!, off); off += p!.length; }
    this.buffers.delete(id);
    return { status: "done", bytes: out };
  }
}
