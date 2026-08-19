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

// gap 补发的字节预算（2026-08-19）。
//
// **只用于 gap 分支。** gap 已经宣告「你落后太多，请重灌」——客户端拿到 resync
// 后会走 reloadHistory 从 tmux 快照重建整屏，环里那几百 KB 历史对屏幕内容毫无
// 贡献，却要跟 term.history 抢同一条 WS。真机日志：8 tab 场景约 2MB 纯白费字节，
// 把 term.history 的 rtt 顶到 9.3 秒（term.history 超时 → 首屏空白）。
//
// **为什么仍要发帧、而不是 gap 时直接跳过重放**（这条被对抗性评审证伪过，四个
// 确认可达的反例，别再改回去）：
//   1. shell 会话的 term.history 恒返回 data:""（rpc-router.ts），重灌 = 纯 RIS
//      清屏。不发帧 → 屏幕永久空白且无任何自愈路径。
//   2. 客户端的 `seen` **只由 output 帧推进**（connection.ts 的 onFrame），resync
//      与 reloadHistory 都不动它。完全不发帧 → seen 永久钉死 → 每次重连必再判
//      gap → 粘性 resync 循环。
//   3. alt buffer（vim/htop）期间 reloadHistory 是无声 early-return，现状靠重放自愈。
//   4. 前端 onResync 是可选链，没有组件实例时静默丢弃。
// 发「最新的一小段」同时满足这四条，又砍掉绝大部分字节。
//
// **为什么按字节而不是帧数**：真机帧均字节跨度 51B~2509B，固定帧数下预算不可控。
//
// 取值依据：手机竖屏一屏约 27 行 × 61 列 = 1647 格，按最坏情况每格 ~20B
// （逐格带 24 位色 SGR）留裕度 ≈ 32KB。它是 256KB 环容量的 1/8，
// 即 gap 路径省下约 87% 的字节。
export const GAP_BACKFILL_BUDGET_BYTES = 32 * 1024;

/**
 * 从积压里取「最新的一段」，总字节不超过 budget，**保持时间顺序**。
 *
 * 至少保留最新一帧——哪怕它自己就超预算。见上面第 2 条：一帧都不发会让客户端
 * 的 seq 记账永久停滞。
 */
export function tailWithinBudget(frames: readonly OutputFrame[], budget: number): OutputFrame[] {
  if (frames.length === 0) return [];
  let bytes = 0;
  let start = frames.length;
  for (let i = frames.length - 1; i >= 0; i--) {
    const next = bytes + frames[i].data.byteLength;
    // start === frames.length 时还一帧没收，无条件收下最新那帧。
    if (next > budget && start < frames.length) break;
    bytes = next;
    start = i;
  }
  return frames.slice(start);
}

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
    // Evict oldest frames until within cap, but always keep at least the newest
    // frame — a single chunk larger than the whole cap intentionally stays,
    // leaving bytes over cap rather than dropping data.
    while (s.bytes > this.capacityBytes && s.ring.length > 1) {
      const dropped = s.ring.shift()!;
      s.bytes -= dropped.data.byteLength;
      s.oldestSeq = s.ring[0].seq;
    }
    return frame;
  }

  since(sessionId: string, lastSeq: number): { frames: OutputFrame[]; gap: boolean; oldestSeq: number } {
    const s = this.sessions.get(sessionId);
    if (!s || s.ring.length === 0) return { frames: [], gap: false, oldestSeq: 0 };
    // gap if the client's lastSeq predates what we still hold.
    const gap = lastSeq + 1 < s.oldestSeq;
    const frames = s.ring.filter((f) => f.seq > lastSeq);
    return { frames, gap, oldestSeq: s.oldestSeq };
  }

  latestSeq(sessionId: string): number {
    const s = this.sessions.get(sessionId);
    return s ? s.nextSeq - 1 : 0;
  }

  // Seq of the oldest frame still retained (0 when nothing is held). Used as
  // the `from` of a resync, matching the attach-gap path's semantics.
  oldestSeq(sessionId: string): number {
    const s = this.sessions.get(sessionId);
    return s && s.ring.length > 0 ? s.oldestSeq : 0;
  }
}
