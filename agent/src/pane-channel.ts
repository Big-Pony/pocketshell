// 窗格通道：不做 tmux 的客户端，只把 tmux 当进程宿主。
//
// 【为什么不再用 `tmux attach`】attach 客户端拿到的是 tmux **画给客户端的重绘流**：
// 一 attach 就进备用屏（`\x1b[?1049h`），此后全是**绝对定位**的整屏刷新。备用屏没有
// scrollback，所以 xterm 那边的历史永远是空的；而我们为了让用户能往上翻，会在重连时
// 塞一份 capture-pane 快照进去 —— 一塞，xterm 的行网格就和 tmux 心里的行网格错开，
// tmux 继续按它的坐标写「第 5 行」，落在手机上却是另一行，**内容当场被覆盖消失**。
// 复制模式什么都不缺，正说明丢的不是数据而是显示。这就是「终端中间丢行」的根因。
//
// 【改成什么】`pipe-pane -O` 取的是**窗格里的程序自己吐的字节**：打印机式、相对定位、
// 没有备用屏、没有屏幕差分。喂给 xterm 之后它的原生 scrollback 就像在普通终端里一样
// 工作，不存在「网格对齐」这回事，根因在结构上消失。实测（spike/tmux-output-probe.ts）：
// 一万行连打 10000/10000 零丢失、顺序单调、流里 `1049h` 0 次、绝对定位 CUP 0 次。
//
// 【输入】不 attach 就没有客户端可写，改走 `send-keys -H`（逐字节十六进制）。
// 实测（spike/tmux-input-probe.ts / probe2）：
//   - 逐**字节**完全保真：ASCII / 0x01 / ESC / LF / CR / 3 字节 CJK / 4 字节 emoji 全对；
//   - 逐**码点**会丢字（16B→6B），所以必须按字节发；
//   - `paste-buffer` 不能用于字节流：默认把 LF 换成 CR，`-s ''` 直接把 LF 删掉；
//   - 单次调用有长度上限：4096B 通过，16384B 报 `command too long`。
//
// 【输出传输】tmux 只能把窗格字节交给一个 shell 命令，所以用 FIFO 中转。两个关键点：
//
// 1. **读端必须是子进程管道，不能是 createReadStream(fd)**。后者读 FIFO 走的是
//    libuv 线程池的**阻塞读**，每个活着的会话永久占住一个线程，而池子默认只有 4 个
//    —— 用户开到第 5 个会话，输出就静默停掉，setup 全部成功、没有任何报错。这是
//    实测出来的（UV_THREADPOOL_SIZE=64 下 47 个用例全绿，默认值下后面的会话一个
//    字节都收不到）。子进程的 stdout 管道由事件循环（kqueue/epoll）驱动，不占线程池；
//    实测 8 个并发通道在默认池子下全部正常。
// 2. **自己另外持有一个 O_RDWR 的 fd 但从不读它**。写端（pipe-pane 起的 cat）在每次
//    pipe-pane 重启时都会消失，没有别的写端在场时 FIFO 就 EOF，我们的读进程随之退出、
//    通道再也回不来。持一个 O_RDWR 就堵住了这个 EOF；因为我们从不 read 它，也不会跟
//    读进程抢字节。实测写端反复消失后通道仍存活。
import { closeSync, constants, existsSync, mkdirSync, openSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PtyHandle } from "./pty";
import type { AsyncTmuxRunner, TmuxRunner } from "./terminal";

// 单次 send-keys 的字节上限。实测 4096 通过、16384 报 `command too long`，
// 取一半留余量（不同 tmux 构建的 argv 上限不同，这里不赌边界）。
export const SEND_CHUNK = 2048;

/** 超过这个字节数的单次写入算「大块输入」（粘贴/听写），留一条计数埋点。 */
export const PASTE_DIAG_BYTES = 64;

/** 把字节切成 send-keys 能吃下的块。导出供单测直接验边界。 */
export function chunkForSend(data: Uint8Array, size = SEND_CHUNK): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += size) out.push(data.subarray(i, Math.min(i + size, data.length)));
  return out;
}

/** send-keys -H 的参数：每字节两位十六进制。空输入返回空数组（调用方不得发空命令）。 */
export function hexArgs(data: Uint8Array): string[] {
  const out: string[] = new Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i]!.toString(16).padStart(2, "0");
  return out;
}

/**
 * 会话名 → FIFO 文件名。会话名可含空格/斜杠/CJK，不能直接进路径；
 * 同时要保证不同名字不会撞同一个文件，所以用「净化名 + 全名哈希」。
 */
export function fifoName(session: string): string {
  const safe = session.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32);
  let h = 5381;
  for (let i = 0; i < session.length; i++) h = ((h * 33) ^ session.charCodeAt(i)) >>> 0;
  return `pane-${safe}-${h.toString(36)}.fifo`;
}

export interface PaneChannelDeps {
  tmux: TmuxRunner;
  tmuxAsync: AsyncTmuxRunner;
  /** FIFO 存放目录，缺省 ~/.pocketshell/run。测试注入临时目录。 */
  runDir?: string;
  /** 建 FIFO 的方式，测试可替换。 */
  mkfifo?: (path: string) => boolean;
}

const defaultMkfifo = (path: string): boolean =>
  Bun.spawnSync(["mkfifo", path]).exitCode === 0;

export class PaneChannel implements PtyHandle {
  private readonly dataCbs: ((chunk: Uint8Array) => void)[] = [];
  private readonly exitCbs: ((code: number) => void)[] = [];
  private fd: number | null = null;
  /** 读进程：`cat <fifo>`，它的 stdout 管道由事件循环驱动（见文件头第 1 点）。 */
  private reader: ReturnType<typeof Bun.spawn> | null = null;
  private fifoPath = "";
  private closed = false;
  /** 写队列：send-keys 必须**按序**到达，而异步 spawn 不保证顺序。 */
  private writeChain: Promise<unknown> = Promise.resolve();
  /** 本通道累计收到的字节数。看门狗的 rx 探头（channel-watchdog.ts），只计数。 */
  private rxTotal = 0;
  /** tap 旁录目录（POCKETSHELL_PANE_TAP），off 时为 null。看门狗 stat 文件大小用。 */
  private readonly tapDir: string | null;

  constructor(
    private readonly session: string,
    private readonly deps: PaneChannelDeps,
  ) {
    this.tapDir = process.env.POCKETSHELL_PANE_TAP ?? null;
    // 目录优先级：显式注入 > POCKETSHELL_RUN_DIR > ~/.pocketshell/run。
    // 环境变量这一档是给测试用的 —— 否则每跑一次单测就往用户真实家目录里造 FIFO。
    const dir = deps.runDir ?? process.env.POCKETSHELL_RUN_DIR ?? join(homedir(), ".pocketshell", "run");
    mkdirSync(dir, { recursive: true });
    this.fifoPath = join(dir, fifoName(session));
    // 上一次 agent 进程留下的同名 FIFO 要先清掉：它的 inode 上可能还挂着旧写端。
    try { if (existsSync(this.fifoPath)) unlinkSync(this.fifoPath); } catch { /* 无所谓 */ }
    (deps.mkfifo ?? defaultMkfifo)(this.fifoPath);

    // 只持有、不读取：堵住 FIFO 的 EOF（见文件头第 2 点）。
    this.fd = openSync(this.fifoPath, constants.O_RDWR);
    this.reader = Bun.spawn(["cat", this.fifoPath], { stdout: "pipe", stderr: "ignore" });
    void this.pump();

    this.startPipe();
  }

  /**
   * 开启/重开 pipe-pane。`-O` = 只要窗格输出，不要我们自己写进去的输入回显。
   *
   * **原始字节旁录（取证用，默认关闭）**：`POCKETSHELL_PANE_TAP=<目录>` 时改用
   * `tee -a` 把窗格原始字节同时落一份到本地文件。这是回答「那段内容到底有没有被
   * 程序写出来过」的**唯一**手段——tmux 历史缺内容时，只有原始流能区分「程序没写」
   * 和「写了但被覆盖」。
   *
   * 与 `diag-missing.txt` 同一性质的**本机文件专用**例外：里面是**真实会话原文**，
   * **绝不可外传**、绝不进日志、绝不进 diag 上报。文件只增不删，用完自己清。
   */
  private startPipe(): void {
    const tapDir = this.tapDir;
    const sink = tapDir
      ? `tee -a '${join(tapDir, fifoName(this.session))}.raw' > '${this.fifoPath}'`
      : `cat > '${this.fifoPath}'`;
    this.deps.tmux(["pipe-pane", "-O", "-t", this.session, sink]);
  }

  onData(cb: (chunk: Uint8Array) => void): void {
    this.dataCbs.push(cb);
  }

  /**
   * 看门狗探头（channel-watchdog.ts 的取样源）。只读计数与 stat size，
   * **永不读 tap 内容**——里面是真实会话原文，红线同 pane-tap。
   * tap 关闭（POCKETSHELL_PANE_TAP 未设）时 tapBytes 为 null，看门狗退化
   * 为只看 history_size 证据。
   */
  health(): { rxBytes: number; tapBytes: number | null } {
    let tapBytes: number | null = null;
    if (this.tapDir !== null) {
      try {
        tapBytes = statSync(join(this.tapDir, fifoName(this.session)) + ".raw").size;
      } catch { /* 尚无旁录文件 = 0 字节产出 */ tapBytes = 0; }
    }
    return { rxBytes: this.rxTotal, tapBytes };
  }

  onExit(cb: (code: number) => void): void {
    this.exitCbs.push(cb);
  }

  /**
   * 会话没了 / 通道坏了。只触发一次，语义与 PTY 退出一致，
   * 好让 TerminalService.onPtyExit 的既有清理逻辑原样复用。
   */
  fail(code = 0): void {
    if (this.closed) return;
    this.closeIo();
    for (const cb of this.exitCbs) cb(code);
  }

  write(data: Uint8Array): void {
    if (this.closed || data.length === 0) return;
    const parts = chunkForSend(data);
    // 大块输入（粘贴/听写）留一条计数埋点。逐键输入不记——那会把日志刷爆，而
    // 正在查的「粘贴内容少一截」只发生在大块这一侧。**只有字节数与块数，没有内容。**
    if (data.length >= PASTE_DIAG_BYTES) {
      console.log(`[pocketshell:diag] ${JSON.stringify({
        kind: "input-paste", session: this.session, bytes: data.length, chunks: parts.length,
      })}`);
    }
    for (const chunk of parts) {
      const args = ["send-keys", "-H", "-t", this.session, ...hexArgs(chunk)];
      // 串行化：前一块 resolve 之后才发下一块，保证字节顺序。
      // 用 async runner 是必须的 —— 同步 spawn 会阻塞事件循环，一次 20KB 粘贴
      // 就会把**所有其他会话**的输出冻住几百毫秒（history() 头部有同样的告诫）。
      this.writeChain = this.writeChain.then(async () => {
        if (this.closed) return;
        // **失败必须出声**。原来这里是 `.catch(() => undefined)` 且不看 exitCode：
        // `send-keys` 一旦失败（argv 过长、会话正好没了、tmux 忙），那一块输入就
        // **静默消失**，用户看到的是「我打的字少了一截」而日志里一个字都没有。
        // 只打计数与 exitCode，**绝不打内容**——日志会被贴进公开 issue。
        let code = 1;
        try {
          code = (await this.deps.tmuxAsync(args)).exitCode;
        } catch { /* spawn 本身失败，按下面的失败分支处理 */ }
        if (code !== 0) {
          console.log(`[pocketshell:diag] ${JSON.stringify({
            kind: "input-drop", session: this.session, bytes: chunk.length, exitCode: code,
          })}`);
        }
      });
    }
  }

  resize(cols: number, rows: number): void {
    if (this.closed) return;
    this.deps.tmux(["resize-window", "-t", this.session, "-x", String(cols), "-y", String(rows)]);
  }

  /** 把读进程的 stdout 抽干并分发。读进程退出即通道失效（正常情况下它不会退出）。 */
  private async pump(): Promise<void> {
    const out = this.reader?.stdout;
    if (!out || typeof out === "number") return;
    try {
      for await (const c of out) {
        if (this.closed) return;
        const buf = new Uint8Array(c);
        this.rxTotal += buf.byteLength;
        for (const cb of this.dataCbs) cb(buf);
      }
    } catch { /* 关闭时的正常中断 */ }
    // 走到这里 = cat 退出了。不静默：留一个收不到任何字节的僵尸通道，
    // 表现就是「会话还在列表里但永远不动」，比直接报死难查得多。
    if (!this.closed) this.fail();
  }

  private closeIo(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.reader?.kill(); } catch { /* 已退 */ }
    this.reader = null;
    if (this.fd !== null) {
      try { closeSync(this.fd); } catch { /* 已关 */ }
    }
    this.fd = null;
    try { if (existsSync(this.fifoPath)) unlinkSync(this.fifoPath); } catch { /* 已删 */ }
  }

  kill(): void {
    if (this.closed) return;
    // 先关 tmux 侧的管子，再关我们这侧，否则 cat 会拿到 SIGPIPE 写进 tmux 日志。
    this.deps.tmux(["pipe-pane", "-t", this.session]);
    this.closeIo();
  }
}
