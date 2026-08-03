// WP-6: reassembly of chunked rpc responses. When the full `response` frame
// exceeds the server's single-frame size cap, it arrives as rpcChunk frames
// ({id, index, total, data=b64 slice of the response JSON bytes}); small
// responses still arrive as one `response` frame. This is the pure,
// unit-testable half — Connection wires it to the rpc pending map and gives
// the buffers the exact same lifetime as a pending rpc (timeout / disconnect
// / settle all drop them).
import { fromB64 } from "./bytes";

// Hard cap on chunks per response: a sane upper bound far above any real
// response (server slices ~60KB, so 10000 chunks ≈ 600MB). Garbage totals
// beyond this would only ever come from a corrupt peer — refuse to allocate.
export const MAX_CHUNKS = 10000;

export interface ChunkFrame {
  id: string;
  index: number;
  total: number;
  data: string;
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
  // total, undecodable data) is an immediate error so the caller can reject
  // the rpc instead of waiting out the 10s timeout.
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
    let bytes: Uint8Array;
    try {
      bytes = fromB64(frame.data);
    } catch {
      return { status: "error", reason: "bad_data" };
    }
    buf.parts[index] = bytes;
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
