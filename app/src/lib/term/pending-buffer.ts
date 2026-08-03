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
  private bytes = 0;
  private limit: number;
  dirty = false;

  constructor(limit = 2 * 1024 * 1024) {
    this.limit = limit;
  }

  push(data: Uint8Array): void {
    if (this.dirty) return;
    this.chunks.push(data);
    this.bytes += data.byteLength;
    if (this.bytes > this.limit) {
      this.chunks = [];
      this.bytes = 0;
      this.dirty = true;
    }
  }

  // Concatenated pending bytes (buffer reset), or null when empty. Callers
  // must check `dirty` first — a dirty buffer keeps nothing to take.
  take(): Uint8Array | null {
    if (this.bytes === 0) return null;
    const all = new Uint8Array(this.bytes);
    let off = 0;
    for (const c of this.chunks) { all.set(c, off); off += c.byteLength; }
    this.chunks = [];
    this.bytes = 0;
    return all;
  }

  clearDirty(): void {
    this.dirty = false;
  }
}
