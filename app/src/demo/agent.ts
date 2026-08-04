// 演示用的假 agent。收 ClientMsg 吐 ServerMsg，是个状态机而不是录像回放器。
//
// 它 import type 真实的 protocol.ts —— 协议字段名一旦漂移，这里会**编译期
// 报错**而不是线上静默失效。这是本方案能长期跟着主线走的关键。
//
// seq 记账是题眼：断线期间内部计时器不停、seq 继续推进，重连后 attach{lastSeq}
// 一次性吐出缺口（见 Task 3 的 replay 缓冲）。
import type { ClientMsg, ServerMsg, SessionMeta } from "../lib/net/protocol";
import { toB64 } from "../lib/bytes";

export interface DemoScheduler {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

export interface DemoAgentOpts {
  push(msg: ServerMsg): void;
  scheduler?: DemoScheduler;
}

// 固定创建时间：演示每次刷新应当一致，用 Date.now() 会让截图与测试都不稳。
// 2026-08-01T09:00:00Z 起算，三个会话依次早于「现在」几十分钟。
const T0 = 1_785_920_400_000;

export const DEMO_SESSIONS: readonly SessionMeta[] = [
  { name: "claude-refactor", kind: "tmux", state: "run",  cols: 80, rows: 24, lastLine: "⏺ Editing src/auth.ts …",       createdAt: T0,             attached: true,  ctxTool: "claude", ctxUsed: 84_300, ctxTotal: 200_000 },
  { name: "kimi-docs",       kind: "tmux", state: "wait", cols: 80, rows: 24, lastLine: "Waiting: apply this patch? (y/n)", createdAt: T0 + 600_000,  attached: true },
  { name: "build-server",    kind: "tmux", state: "idle", cols: 80, rows: 24, lastLine: "✓ Done in 34.2s",                createdAt: T0 + 1_200_000, attached: false },
];

const PROMPT = "\r\n\x1b[38;5;208m~/demo\x1b[0m $";
const enc = new TextEncoder();

export class DemoAgent {
  private push: ((msg: ServerMsg) => void) | null;
  private readonly sched: DemoScheduler;
  private sessions: SessionMeta[];
  private attached = new Set<string>();
  /** 全局单调 seq。只要单调，补齐逻辑就正确，比 per-session 更难写错。 */
  private seq = 0;
  /** 每会话的当前输入行，用于回车时解析命令。 */
  private lines = new Map<string, string>();

  constructor(opts: DemoAgentOpts) {
    this.push = opts.push;
    this.sched = opts.scheduler ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
      clearTimeout: (id) => clearTimeout(id),
    };
    this.sessions = DEMO_SESSIONS.map((s) => ({ ...s }));
  }

  /** 换 socket（重连）。Task 3 用。 */
  setPush(push: (msg: ServerMsg) => void): void { this.push = push; }
  /** 断线：不再往外推，但内部计时器照跑。Task 3 用。 */
  detachTransport(): void { this.push = null; }

  snapshotSessions(): SessionMeta[] { return this.sessions.map((s) => ({ ...s })); }

  handle(msg: ClientMsg): void {
    switch (msg.type) {
      case "ping":         this.send({ type: "pong" }); break;
      case "listSessions": this.broadcastSessions(); break;
      case "attach":       this.attached.add(msg.sessionId); break;
      case "detach":       this.attached.delete(msg.sessionId); break;
      case "input":        this.onInput(msg.sessionId, msg.data); break;
      case "newSession":
        this.sessions = [...this.sessions, {
          name: msg.name, kind: msg.kind ?? "tmux", state: "idle",
          cols: 80, rows: 24, lastLine: "", createdAt: T0 + 1_800_000, attached: true,
        }];
        this.broadcastSessions();
        break;
      case "kill":
        this.sessions = this.sessions.filter((s) => s.name !== msg.sessionId);
        this.attached.delete(msg.sessionId);
        this.broadcastSessions();
        break;
      case "renameSession":
        this.sessions = this.sessions.map((s) => (s.name === msg.sessionId ? { ...s, name: msg.name } : s));
        this.broadcastSessions();
        break;
      // resize / presence 无副作用；其余（rpc、snippets、hints、pair…）在 Task 5 接。
      default: break;
    }
  }

  /** 推一段输出。文本按 UTF-8 → base64，与真 agent 的线格式一致。 */
  emitOutput(sessionId: string, text: string): void {
    const seq = ++this.seq;
    if (!this.attached.has(sessionId)) return; // 未订阅不投递（对齐真 agent）
    this.send({ type: "output", sessionId, seq, data: toB64(enc.encode(text)) });
  }

  private onInput(sessionId: string, dataB64: string): void {
    const text = new TextDecoder().decode(Uint8Array.from(atob(dataB64), (c) => c.charCodeAt(0)));
    const cur = this.lines.get(sessionId) ?? "";
    if (text === "\r" || text === "\n") {
      this.lines.set(sessionId, "");
      this.emitOutput(sessionId, "\r\n");
      this.sched.setTimeout(() => this.runCommand(sessionId, cur.trim()), 0);
      return;
    }
    if (text === "\x7f") { // 退格
      this.lines.set(sessionId, cur.slice(0, -1));
      this.emitOutput(sessionId, "\b \b");
      return;
    }
    this.lines.set(sessionId, cur + text);
    this.emitOutput(sessionId, text); // 本地回显
  }

  /** Task 4 会把它换成真正的分级分发；此刻先保证「有输出且收在提示符」。 */
  protected runCommand(sessionId: string, line: string): void {
    if (line === "ls") this.emitOutput(sessionId, "README.md  src  package.json");
    this.emitOutput(sessionId, PROMPT);
  }

  private broadcastSessions(): void {
    this.send({ type: "sessions", sessions: this.snapshotSessions() });
  }

  protected send(msg: ServerMsg): void {
    this.push?.(msg);
  }
}
