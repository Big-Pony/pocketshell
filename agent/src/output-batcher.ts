// A2 output batching: PTY data events arrive in many small bursts (a
// full-screen redraw can be dozens of events), and each used to become its own
// numbered frame + JSON encode + encrypt + WS frame per connection. Accumulate
// per session and flush either when the batch reaches `flushBytes` or when the
// window opened by the batch's first byte expires. The 8ms default caps added
// latency for keystroke echo, which travels this same path. The flushed byte
// string is ingested as ONE replay frame (one seq), so seq semantics and the
// wire protocol are unchanged. Timer functions are injectable for tests.

export interface OutputBatcherOpts {
  flushBytes?: number; // immediate-flush threshold, default 4096
  flushMs?: number; // window opened by a batch's first byte, default 8
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

interface Pending {
  parts: Uint8Array[];
  bytes: number;
  timer: unknown; // non-null while the flush window is open
}

function concat(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

export class OutputBatcher {
  private pending = new Map<string, Pending>();
  private flushBytes: number;
  private flushMs: number;
  private setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private clearTimeoutFn: (handle: unknown) => void;

  constructor(
    private onFlush: (sessionId: string, data: Uint8Array) => void,
    opts: OutputBatcherOpts = {},
  ) {
    this.flushBytes = opts.flushBytes ?? 4096;
    this.flushMs = opts.flushMs ?? 8;
    this.setTimeoutFn = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = opts.clearTimeout ?? ((h) => clearTimeout(h as never));
  }

  push(sessionId: string, chunk: Uint8Array): void {
    let p = this.pending.get(sessionId);
    if (!p) {
      p = { parts: [], bytes: 0, timer: null };
      this.pending.set(sessionId, p);
    }
    if (p.bytes === 0) {
      // First byte of a new batch opens the flush window. unref so a pending
      // window never keeps the process (or `bun test`) alive on its own.
      const t = this.setTimeoutFn(() => this.flush(sessionId), this.flushMs);
      (t as { unref?: () => void } | null)?.unref?.();
      p.timer = t;
    }
    p.parts.push(chunk);
    p.bytes += chunk.byteLength;
    if (p.bytes >= this.flushBytes) this.flush(sessionId);
  }

  // Deliver whatever is buffered for the session right now (no-op when empty).
  flush(sessionId: string): void {
    const p = this.pending.get(sessionId);
    if (!p || p.bytes === 0) return;
    if (p.timer !== null) this.clearTimeoutFn(p.timer);
    this.pending.delete(sessionId);
    this.onFlush(sessionId, p.parts.length === 1 ? p.parts[0] : concat(p.parts, p.bytes));
  }

  // Drop buffered bytes and cancel the window (session destroyed / shutdown).
  clear(sessionId: string): void {
    const p = this.pending.get(sessionId);
    if (p && p.timer !== null) this.clearTimeoutFn(p.timer);
    this.pending.delete(sessionId);
  }

  clearAll(): void {
    for (const id of [...this.pending.keys()]) this.clear(id);
  }
}
