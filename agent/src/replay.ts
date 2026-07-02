// A4 ReplayService: number each output chunk per session, keep a byte-capped
// ring buffer, serve gap-aware backfill on reconnect. No crypto, no PTY.

export interface OutputFrame {
  sessionId: string;
  seq: number;
  data: Uint8Array;
}

interface SessionReplay {
  nextSeq: number;
  oldestSeq: number; // seq of the oldest frame still in `ring` (0 if empty)
  bytes: number;
  ring: OutputFrame[];
}

const DEFAULT_CAP = 256 * 1024;

export class ReplayService {
  private sessions = new Map<string, SessionReplay>();
  constructor(private capacityBytes: number = DEFAULT_CAP) {}

  private get(sessionId: string): SessionReplay {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = { nextSeq: 1, oldestSeq: 0, bytes: 0, ring: [] };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  ingest(sessionId: string, chunk: Uint8Array): OutputFrame {
    const s = this.get(sessionId);
    const frame: OutputFrame = { sessionId, seq: s.nextSeq++, data: chunk };
    s.ring.push(frame);
    s.bytes += chunk.byteLength;
    if (s.ring.length === 1) s.oldestSeq = frame.seq;
    // Evict oldest frames until within cap (always keep at least the newest).
    while (s.bytes > this.capacityBytes && s.ring.length > 1) {
      const dropped = s.ring.shift()!;
      s.bytes -= dropped.data.byteLength;
      s.oldestSeq = s.ring[0].seq;
    }
    return frame;
  }

  since(sessionId: string, lastSeq: number): { frames: OutputFrame[]; gap: boolean } {
    const s = this.sessions.get(sessionId);
    if (!s || s.ring.length === 0) return { frames: [], gap: false };
    // gap if the client's lastSeq predates what we still hold.
    const gap = lastSeq < s.oldestSeq;
    const frames = s.ring.filter((f) => f.seq > lastSeq);
    return { frames, gap };
  }

  latestSeq(sessionId: string): number {
    const s = this.sessions.get(sessionId);
    return s ? s.nextSeq - 1 : 0;
  }
}
