// 演示用的假 agent。收 ClientMsg 吐 ServerMsg，是个状态机而不是录像回放器。
//
// 它 import type 真实的 protocol.ts —— 协议字段名一旦漂移，这里会**编译期
// 报错**而不是线上静默失效。这是本方案能长期跟着主线走的关键。
//
// seq 记账是题眼：断线期间内部计时器不停、seq 继续推进，重连后 attach{lastSeq}
// 一次性吐出缺口（见 Task 3 的 replay 缓冲）。
import type { ClientMsg, ServerMsg, SessionMeta } from "../lib/net/protocol";
import { toB64 } from "../lib/bytes";
import { DEMO_ROOT, resolvePath, listDir, readFile, lookup, treeAt } from "./fs";
import { tr } from "../lib/i18n";
import { GIT_BRANCHES, GIT_STATUS, GIT_LOG, DIFF_HUNKS, DEMO_HINTS, demoSnippets } from "./git";

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

// 环形缓冲上限。演示不需要真 agent 那样按字节算，条数足够——一幕戏几十帧。
export const REPLAY_CAP = 500;

// 演示的预览 token 是个常量：配合演示包里真实存在的 public-demo/preview/demo/**
// 静态文件（由 vite.config 的 demoAssets() 插件只在演示构建里拷进 dist），
// FilePreview 拼出的 /preview/demo/<relpath> 就是一个普通静态请求。
export const DEMO_PREVIEW_TOKEN = "demo";

interface Frame { sessionId: string; seq: number; data: string }

export class DemoAgent {
  private push: ((msg: ServerMsg) => void) | null;
  private readonly sched: DemoScheduler;
  private sessions: SessionMeta[];
  private attached = new Set<string>();
  /** 全局单调 seq。只要单调，补齐逻辑就正确，比 per-session 更难写错。 */
  private seq = 0;
  /** 每会话的当前输入行，用于回车时解析命令。 */
  private lines = new Map<string, string>();
  /** 断线补齐用的环形缓冲。emitOutput 无论是否在线都入缓冲。 */
  private replay: Frame[] = [];
  /** 每会话的 cwd。cd 改它，pwd/ls/cat 读它。 */
  private cwd = new Map<string, string>();

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

  /**
   * 主动推一次 snippets。**对齐真 agent 的语义**：真后端在增删改后调
   * `pushSnippets()` 广播全量列表（server.ts:394），前端 SnippetPanel 只在挂载时
   * 拉一次、之后靠推送更新。
   *
   * 演示里的触发源是**切语言**——标签取自 i18n，语言变了列表内容就变了，
   * 不重推的话面板会一直显示切换前那套（组件把 items 存在自己的 state 里）。
   */
  pushSnippets(): void { this.send({ type: "snippets", items: demoSnippets() }); }

  snapshotSessions(): SessionMeta[] { return this.sessions.map((s) => ({ ...s })); }

  handle(msg: ClientMsg): void {
    switch (msg.type) {
      case "ping":         this.send({ type: "pong" }); break;
      case "listSessions": this.broadcastSessions(); break;
      case "attach":
        this.attached.add(msg.sessionId);
        if (msg.lastSeq !== undefined) this.replayFrom(msg.sessionId, msg.lastSeq);
        break;
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
      case "rpc":        this.onRpc(msg.id, msg.method, msg.params); break;
      case "listSnippets": this.pushSnippets(); break;
      // resize / presence 无副作用；其余（hints、pair…）在后续任务接。
      default: break;
    }
  }

  /**
   * 推一段输出。文本按 UTF-8 → base64，与真 agent 的线格式一致。
   *
   * **先入缓冲、后判投递**：断线期间 push 为 null，但帧必须已经在缓冲里，
   * 否则重连时补不出来——这正是整个演示的题眼所在。
   */
  emitOutput(sessionId: string, text: string): void {
    const seq = ++this.seq;
    const frame: Frame = { sessionId, seq, data: toB64(enc.encode(text)) };
    this.replay.push(frame);
    if (this.replay.length > REPLAY_CAP) this.replay.shift();
    if (!this.attached.has(sessionId)) return; // 未订阅不投递（对齐真 agent）
    this.send({ type: "output", ...frame });
  }

  /** 推一条系统通知（第三幕）。ts 用固定值以免测试与截图漂移。 */
  pushNotification(sessionId: string, title: string, body: string): void {
    this.send({ type: "notification", sessionId, title, body, ts: T0 });
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

  /**
   * 分级响应（设计文档 2.4）：
   *   真实模拟 —— 由假 FS 真实计算
   *   脚本化   —— 播预录分段输出，带打字机节奏
   *   兜底     —— 友好提示，鼓励乱试
   */
  protected runCommand(sessionId: string, line: string): void {
    const cwd = this.cwd.get(sessionId) ?? DEMO_ROOT;
    const [cmd, ...args] = line.split(/\s+/).filter(Boolean);
    const arg = args.join(" ");

    if (!cmd) { this.emitOutput(sessionId, PROMPT); return; }

    switch (cmd) {
      case "pwd":
        this.emitOutput(sessionId, cwd + PROMPT);
        return;
      case "clear":
        this.emitOutput(sessionId, "\x1b[2J\x1b[H" + PROMPT.replace(/^\r\n/, ""));
        return;
      case "echo":
        this.emitOutput(sessionId, arg + PROMPT);
        return;
      case "cd": {
        const target = resolvePath(cwd, arg || DEMO_ROOT);
        const node = lookup(target);
        if (!node) { this.emitOutput(sessionId, tr("demo.shell.noSuchFile", { cmd, name: arg }) + PROMPT); return; }
        if (node.type !== "dir") { this.emitOutput(sessionId, tr("demo.shell.notADirectory", { cmd, name: arg }) + PROMPT); return; }
        this.cwd.set(sessionId, target);
        this.emitOutput(sessionId, PROMPT);
        return;
      }
      case "ls": {
        const entries = listDir(resolvePath(cwd, arg));
        if (!entries) { this.emitOutput(sessionId, tr("demo.shell.noSuchFile", { cmd, name: arg || "." }) + PROMPT); return; }
        // 目录加尾斜杠，与真 shell 的 ls -F 观感一致
        const names = entries.map((e) => (e.node.type === "dir" ? `${e.name}/` : e.name));
        this.emitOutput(sessionId, names.join("  ") + PROMPT);
        return;
      }
      case "cat": {
        const f = readFile(resolvePath(cwd, arg));
        if (!f) { this.emitOutput(sessionId, tr("demo.shell.noSuchFile", { cmd, name: arg }) + PROMPT); return; }
        this.emitOutput(sessionId, f.content + PROMPT);
        return;
      }
      case "help":
        this.emitOutput(sessionId, "ls  cd  pwd  cat  echo  clear  claude  git  npm" + PROMPT);
        return;
    }

    const script = SCRIPTED[line] ?? SCRIPTED[cmd];
    if (script) { this.playScript(sessionId, script); return; }

    this.emitOutput(sessionId, tr("demo.shell.fallback") + PROMPT);
  }

  /** 分段播放：每段之间隔一拍，观感是「在跑」而不是「贴了一坨」。 */
  private playScript(sessionId: string, chunks: readonly string[], i = 0): void {
    if (i >= chunks.length) { this.emitOutput(sessionId, PROMPT); return; }
    this.emitOutput(sessionId, chunks[i]);
    this.sched.setTimeout(() => this.playScript(sessionId, chunks, i + 1), 420);
  }

  /**
   * 断线补齐：吐出该会话所有 seq > lastSeq 的缓冲帧。
   *
   * 若 lastSeq 早于缓冲里最老的一帧，说明中间有内容已被挤掉——按真 agent 的
   * 语义下发 resync，让前端知道「这段补不全」而不是假装完整。
   */
  private replayFrom(sessionId: string, lastSeq: number): void {
    // `this.replay` 是跨会话共享的单一环形缓冲，replay[0] 可能属于别的会话——
    // 「最老一帧」必须限定在该 sessionId 自己的帧里，否则别的会话把缓冲挤爆时
    // 会误伤这个会话（明明没漏任何帧也被判定为有缺口而下发 resync）。
    const mine = this.replay.filter((f) => f.sessionId === sessionId);
    const oldest = mine.length ? mine[0].seq : lastSeq + 1; // 该会话缓冲里没有帧：没有缺口可报
    if (lastSeq + 1 < oldest) this.send({ type: "resync", sessionId, from: oldest });
    for (const f of mine) {
      if (f.seq <= lastSeq) continue;
      this.send({ type: "output", ...f });
    }
  }

  /**
   * rpc 分发。**每一条都必须有 response** —— 没有的话前端会挂到 rpc 超时
   * （connection.ts 的 10s 死线），表现为面板一直转圈，比明确报错糟得多。
   */
  private onRpc(id: string, method: string, params?: unknown): void {
    const p = (params ?? {}) as Record<string, unknown>;
    const ok = (result: unknown) => this.send({ type: "response", id, ok: true, result });
    const fail = (code: string, message: string) => this.send({ type: "response", id, ok: false, error: { code, message } });

    switch (method) {
      case "fs.tree": {
        const t = treeAt(String(p.path ?? DEMO_ROOT));
        return t ? ok(t) : fail("enoent", "no such directory");
      }
      case "fs.read": {
        const path = String(p.path ?? "");
        const f = readFile(path);
        return f ? ok({ path, ...f }) : fail("enoent", "no such file");
      }
      case "fs.diff":     return ok(DIFF_HUNKS);
      case "git.status":  return ok(GIT_STATUS);
      case "git.branches":return ok(GIT_BRANCHES);
      case "git.log":     return ok(GIT_LOG);
      case "hints.list":  return ok(DEMO_HINTS);
      case "preview.mint":return ok({ token: DEMO_PREVIEW_TOKEN });
      case "agent.info":  return ok({ instanceName: null });
      case "terminal.pwd":return ok({ pwd: this.cwd.get(String(p.session ?? "")) ?? DEMO_ROOT });
      case "term.paneInfo": return ok({ currentCommand: "", alternateOn: false, isShell: false });
      // 演示不做历史快照：回空 + 当前 seq，前端 attach(seq) 之后接实时流。
      case "term.history":  return ok({ data: "", seq: this.seq });
      case "term.capture":  return ok({ data: "", atTop: true });
      // 无副作用的控制类：认了但什么都不做，回 ok 让调用方继续。
      case "term.redraw":   return ok({});
      case "update.check":  return ok({ current: __APP_VERSION__, latest: __APP_VERSION__, hasUpdate: false });
      default:
        // 写操作、通知接线、OTA 应用、上传下载，以及任何没见过的 method。
        return fail("demo_unsupported", "not available in the demo sandbox");
    }
  }

  private broadcastSessions(): void {
    this.send({ type: "sessions", sessions: this.snapshotSessions() });
  }

  protected send(msg: ServerMsg): void {
    this.push?.(msg);
  }
}

// 脚本化档的预录输出。**刻意不走 i18n**：这是模拟的 CLI 输出，真实工具本来
// 就只有英文，翻译反而失真。兜底提示那种「我们对访客说的话」才走 i18n。
const SCRIPTED: Record<string, readonly string[]> = {
  claude: [
    "\x1b[38;5;208m⏺\x1b[0m Analyzing the repository…",
    "  Read src/auth.ts (18 lines)",
    "  Read src/crypto.ts (21 lines)",
    "\x1b[38;5;208m⏺\x1b[0m The session check looks fine, but verify() compares MACs\n  of different lengths before timingSafeEqual — that throws.",
    "\x1b[38;5;208m⏺\x1b[0m Editing src/auth.ts …",
  ],
  "git status": [
    "On branch main",
    "Changes not staged for commit:",
    "  \x1b[31mmodified:   src/auth.ts\x1b[0m",
    "Untracked files:",
    "  \x1b[31mtests/auth.test.ts\x1b[0m",
  ],
  "git diff": [
    "\x1b[1mdiff --git a/src/auth.ts b/src/auth.ts\x1b[0m",
    "@@ -8,6 +8,7 @@ export function checkSession(token: string) {",
    "\x1b[32m+  if (!claims) return null;\x1b[0m",
    "   if (claims.expiresAt < Date.now()) return null;",
  ],
  "npm test": [
    "> demo-project@0.3.1 test",
    "> vitest run",
    " \x1b[32m✓\x1b[0m tests/auth.test.ts (1 test) 12ms",
    "\x1b[32m Test Files  1 passed (1)\x1b[0m",
  ],
};
