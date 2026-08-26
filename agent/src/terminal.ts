// A2 TerminalService: sessions are tmux sessions; a PTY attaches to each so we
// can stream bytes. Adds heuristic state inference (via inferState), lastLine
// capture, and a rename hook. Emits raw bytes only — seq/buffer is A4.
import type { PtyHandle } from "./pty";
import { PaneChannel } from "./pane-channel";
import { inferState, StateHysteresis } from "./state";
import { toB64 } from "./bytes";
import { cjkFallbackLang } from "./pty-env";
import type { SessionMeta, TermHistoryResult } from "./protocol";

// Sanity bound for capture()'s `back`. Generous next to tmux's default
// history-limit (2000) so a legitimate anchor is never rejected, small enough
// that a corrupt value can't become a silly argv token.
export const CAPTURE_BACK_LIMIT = 1_000_000;

/**
 * 给「取到可视区底部」的快照补上光标定位，让客户端重灌之后的**行网格与光标位置
 * 都和 tmux 完全一致**——后面接上来的实时字节才落得对。
 *
 * 【为什么两件事缺一不可】窗格里的程序（Claude Code、vim…）重绘用的是**相对光标
 * 移动**（`ESC[nA` / `ESC[nB` / `ESC[K`）。这类字节只有在「终端的光标正好在程序
 * 以为的位置」时才画得对。重灌把一份 capture-pane 快照顺序写进 xterm，写完光标
 * 停在**最后一行的行尾**，而 tmux 的光标可能在屏幕中间：
 *
 *   - 只截到光标行（`-E <cursor_y>`）：光标下方那些行**根本没写进去**。对 TUI 来说
 *     那不是空白——Claude Code 的输入框下面还有边框和状态栏，直接被截掉；同时
 *     xterm 光标停在视口底部，tmux 的却在中间。**2026-08-26 实测 Δy=10，27 行里
 *     25 行对不上**，屏幕上表现为「刚打的那句话和 AI 回复整段不出现」。
 *   - 只取整屏（`-E -`）而不摆光标：行网格对了，光标仍停在最后一行，还是错位。
 *
 * 所以：取整屏保证网格一致，再补一条 `ESC[<y+1>;<x+1>H` 把光标摆回去。**必须先去掉
 * 末尾那个换行再补 CUP**，否则那个换行会让 xterm 多滚一行，视口整体偏一行。
 *
 * 只对「结束在可视区底部」的快照做这件事；分页取历史（有显式终点）不能补，那份
 * 不是拿来接实时流的。
 */
export function withCursorFix(rows: Uint8Array, cursor: { x: number; y: number }): Uint8Array {
  let end = rows.length;
  if (end > 0 && rows[end - 1] === 0x0a) end--;      // \n
  if (end > 0 && rows[end - 1] === 0x0d) end--;      // \r\n
  const x = Number.isFinite(cursor.x) ? Math.max(0, cursor.x) : 0;
  const y = Number.isFinite(cursor.y) ? Math.max(0, cursor.y) : 0;
  const cup = new TextEncoder().encode(`\x1b[${y + 1};${x + 1}H`);
  const out = new Uint8Array(end + cup.length);
  out.set(rows.subarray(0, end), 0);
  out.set(cup, end);
  return out;
}

interface Live {
  pty: PtyHandle;
  meta: SessionMeta;
  lastOutputAt: number;
  lastReattachAt?: number;
}

export interface TmuxResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}
export type TmuxRunner = (args: string[]) => TmuxResult;
// Async counterpart used on the hot probe paths (1s scanner + list()). Same
// TmuxResult contract and same failure semantics: a missing/failing tmux
// degrades to exitCode 1, never a throw.
export type AsyncTmuxRunner = (args: string[]) => Promise<TmuxResult>;

interface TmuxRosterEntry {
  name: string;
  createdAt: number;
  cols: number;
  rows: number;
}

// Default runner: spawn real tmux. Resilient to a missing binary (returns a
// non-zero result instead of throwing) so callers degrade gracefully and unit
// tests without tmux still pass.
const defaultTmux: TmuxRunner = (args) => {
  try {
    const r = Bun.spawnSync(["tmux", ...args]);
    return {
      exitCode: r.exitCode ?? 0,
      stdout: r.stdout ?? new Uint8Array(),
      stderr: r.stderr ?? new Uint8Array(),
    };
  } catch {
    return { exitCode: 1, stdout: new Uint8Array(), stderr: new Uint8Array() };
  }
};

// Async default runner (WP-3a): Bun.spawn keeps the event loop free while
// tmux runs — the scanner + list() fan out several probes per round, and the
// old spawnSync versions blocked every RPC/output forward behind them.
const defaultTmuxAsync: AsyncTmuxRunner = async (args) => {
  try {
    const proc = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      Bun.readableStreamToArrayBuffer(proc.stdout),
      Bun.readableStreamToArrayBuffer(proc.stderr),
      proc.exited,
    ]);
    return { exitCode, stdout: new Uint8Array(stdout), stderr: new Uint8Array(stderr) };
  } catch {
    return { exitCode: 1, stdout: new Uint8Array(), stderr: new Uint8Array() };
  }
};

const SCAN_INTERVAL_MS = 1000;

export class TerminalService {
  private sessions = new Map<string, Live>();
  private outputCbs: ((name: string, chunk: Uint8Array) => void)[] = [];
  private exitCbs: ((name: string, code: number) => void)[] = [];
  private sessionsChangeCbs: (() => void)[] = [];
  // Published per-session states with flip hysteresis (WP-3a). Fed ONLY by
  // the 1s scanner; list() reads these instead of re-inferring per call, so a
  // bursty session's run/wait flap neither reaches clients nor re-triggers
  // sessions broadcasts.
  private states = new Map<string, StateHysteresis>();
  private scanTimer: ReturnType<typeof setInterval>;
  private tmux: TmuxRunner;
  // Async runner for the hot probe paths (scanner + list). The sync runner
  // stays for one-shot, user-initiated RPC/control calls (history, paneInfo,
  // ensure, rename, ...).
  private tmuxAsync: AsyncTmuxRunner;
  private scanning = false;
  private disposed = false;
  // UTF-8 LANG to seed into new tmux sessions when the agent's own env has no
  // locale (see ensure() for why this must land on the server, not the client).
  private langFallback: string | null;

  constructor(deps: { tmux?: TmuxRunner; tmuxAsync?: AsyncTmuxRunner; langFallback?: string | null } = {}) {
    this.tmux = deps.tmux ?? defaultTmux;
    // Tests that inject only the sync fake get it wrapped, keeping the async
    // probe paths hermetic; production (no injected runner) gets real
    // non-blocking spawns via defaultTmuxAsync.
    this.tmuxAsync =
      deps.tmuxAsync ?? (deps.tmux ? async (args) => deps.tmux!(args) : defaultTmuxAsync);
    // `??` would treat an explicit `null` (tests asserting "no fallback") the
    // same as "omitted" and recompute a default — check presence instead so
    // callers can deliberately force no LANG injection.
    this.langFallback =
      deps.langFallback !== undefined ? deps.langFallback : cjkFallbackLang(process.env);
    this.scanTimer = setInterval(() => this.scan(), SCAN_INTERVAL_MS);
    // Don't let the scanner keep the process (or `bun test`) alive on its own.
    (this.scanTimer as unknown as { unref?: () => void }).unref?.();
    void this.clearStalePipes();
  }

  /**
   * 启动时把上一条命的 `pipe-pane` 残留全部关掉。
   *
   * 【为什么必须做】agent 崩溃/重启时来不及 kill 通道，tmux 那边的管子还开着，
   * 而管子另一头的 `sh -c cat > fifo` 是 **tmux server 的子进程**、不跟着 agent 死。
   * 新 agent 起来后会 unlink 并重建同名 FIFO，于是旧 `cat` 手里剩一个孤儿 inode：
   * 它写不进去（没有读端、管道写满）就**永久堵在 write() 上**，而 tmux 仍在往这根
   * 堵死的管子里灌窗格输出，缓冲只增不减。只有当手机重新打开那个会话、
   * `pipe-pane -O` 把它替换掉才会解除——没被重开的会话会一直堵着。
   *
   * 本机实测（2026-08-26）：两个 `sh -c cat` 分别从前一天 15:34 / 22:31 活到第二天
   * 中午，扛过了三次 agent 重启，对应的两个会话 tmux 都报 `pane_pipe=1`。
   *
   * 关管子是幂等且无副作用的（`pipe-pane` 不带命令 = 关闭当前管子），对没有管子的
   * 会话是 no-op，所以可以无差别地对**所有**会话执行，包括不是本 agent 建的。
   */
  private async clearStalePipes(): Promise<void> {
    try {
      // `-u` 和 roster 同理：launchd 的 C locale 下 tmux 会把非 ASCII 洗成 `_`，
      // 中文名会话的名字对不上，残留管子就清不掉。
      const res = await this.tmuxAsync(["-u", "list-sessions", "-F", "#{session_name}\t#{pane_pipe}"]);
      if (res.exitCode !== 0) return;
      for (const line of new TextDecoder().decode(res.stdout).split("\n")) {
        const [name, piped] = line.split("\t");
        if (!name || piped !== "1") continue;
        await this.tmuxAsync(["pipe-pane", "-t", name]);
      }
    } catch { /* 没有 tmux / 没有会话：启动路径不因此失败 */ }
  }

  onOutput(cb: (name: string, chunk: Uint8Array) => void): void {
    this.outputCbs.push(cb);
  }
  onExit(cb: (name: string, code: number) => void): void {
    this.exitCbs.push(cb);
  }
  onSessionsChange(cb: () => void): void {
    this.sessionsChangeCbs.push(cb);
  }

  private emitSessionsChange(): void {
    for (const cb of this.sessionsChangeCbs) cb();
  }

  private hasSession(name: string): boolean {
    return this.tmux(["has-session", "-t", name]).exitCode === 0;
  }

  private async hasSessionAsync(name: string): Promise<boolean> {
    return (await this.tmuxAsync(["has-session", "-t", name])).exitCode === 0;
  }

  // Recompute run/wait for live sessions; fire onSessionsChange only when a
  // debounced state actually flips. Probes run concurrently; a tick arriving
  // while the previous round is still probing is dropped rather than stacked
  // (the interval fires again in 1s — stacking would just queue more spawns).
  private scan(): void {
    if (this.scanning || this.disposed) return;
    this.scanning = true;
    void this.scanAsync()
      .catch(() => { /* an injected runner may throw; never kill the interval */ })
      .finally(() => {
        this.scanning = false;
      });
  }

  private async scanAsync(): Promise<void> {
    const now = Date.now();
    const entries = [...this.sessions.entries()];
    const probes = await Promise.all(
      entries.map(async ([name, live]) => {
        const alive = await this.hasSessionAsync(name);
        return {
          name,
          alive,
          inferred: inferState({ hasSession: alive, lastOutputAt: live.lastOutputAt, now }),
        };
      }),
    );
    if (this.disposed) return;
    let changed = false;
    // 会话消亡的检测点。换掉 `tmux attach` 之后（见 openChannel）不再有 PTY 退出
    // 事件来报信，改由这个扫描器发现 —— 它本来就在查 has-session，白拿的信号。
    //
    // 【两条必须守住的纪律，各踩过一次】
    // 1) **二次确认才判死**。轮询探测不是权威信号：`tmux has-session` 的 spawn
    //    在高负载下会偶发失败，defaultTmuxAsync 把任何异常都降级成 exitCode 1，
    //    单次 false 完全可能是假死。确认一次的成本是一个 spawn，代价是把活着的
    //    会话误杀。
    // 2) **不要走 onPtyExit 的「重连」分支**。那条分支是给「PTY 死了但会话还在」
    //    设计的，会 `live.pty = openChannel(...)` 直接替换引用而不 kill 旧的 ——
    //    从前旧 PTY 已经死了所以无害，现在旧通道还活着，替换会泄漏它的 fd/流，
    //    而新通道构造时又会 unlink 同名 FIFO 重建 inode，旧 cat 于是把窗格输出
    //    打进一个没人读的旧 inode：**该会话从此静默无输出**。B2 下压根没有
    //    「detach」这回事，会话不在了就只有一个结局 —— 收尸。
    for (const { name, alive } of probes) {
      if (alive || !this.sessions.has(name)) continue;
      if (this.hasSession(name)) continue; // 假死，放过
      this.reap(name, 0);
    }
    for (const { name, inferred } of probes) {
      if (!this.sessions.has(name)) continue; // killed/renamed while probing
      let m = this.states.get(name);
      if (!m) {
        // No baseline (ensure() seeds one, so this is defensive): adopt the
        // first inference immediately instead of debouncing it.
        this.states.set(name, new StateHysteresis(inferred));
        continue;
      }
      if (m.next(inferred)) changed = true;
    }
    if (changed) this.emitSessionsChange();
  }

  // Grab the bottom-most non-empty line of the pane for the task-panel preview.
  // `-u` forces UTF-8 output: under launchd (no LANG/LC_*) tmux runs in the C
  // locale and sanitizes non-ASCII / control bytes to `_`, which would corrupt
  // CJK previews. Same locale issue as attach()/roster(); keep `-u`.
  private async captureLastLine(name: string): Promise<string> {
    const res = await this.tmuxAsync(["-u", "capture-pane", "-p", "-t", name]);
    if (res.exitCode !== 0) return "";
    const lines = new TextDecoder()
      .decode(res.stdout)
      .split("\n")
      .map((l) => l.replace(/\s+$/, ""))
      .filter((l) => l.length > 0);
    return lines.length ? lines[lines.length - 1] : "";
  }

  // Export the pane's full scrollback + current visible content as raw bytes
  // with SGR colours preserved, so the frontend can seed xterm's buffer on
  // attach. `-e` keeps colours, `-J` unwraps tmux-folded long lines, `-S -`
  // starts at the top of history, `-E -` ends at the bottom of the visible
  // screen. The frontend clears its own buffer before writing, so the entire
  // captured pane is reproduced without duplication.
  //
  // A full 2000-line scrollback (~200KB of SGR) does not fit one Noise frame;
  // the rpc layer chunks oversize responses (WP-6), so this always returns the
  // complete capture — the WP-1 halving-retry shrink is gone.
  //
  // ASYNC on purpose: a 200KB capture through the SYNC runner blocks Bun's
  // event loop, freezing output for EVERY other session for the duration.
  // captureLastLine() above already uses tmuxAsync for the same reason.
  //
  // `seq` is passed in rather than read here: TerminalService owns no
  // ReplayService reference (they only meet in server.ts), and injecting one
  // would couple a plain tmux wrapper to replay bookkeeping. The caller takes
  // the number BEFORE awaiting this capture — see the server.ts call site.
  // It is echoed back unchanged, including on failure: dropping it would make
  // the frontend fall back to attach(0) and replay the whole ring buffer,
  // which is exactly the double-render this change removes.
  //
  // `lines` = 只取最近多少行（缺省 = 整份 scrollback）。手机屏一次只显示二十几
  // 行，而整份 2000 行带 SGR 是 134KB、base64 后 179KB，在真机链路上要七秒——
  // 首屏拉全量是纯粹的浪费。capture() 的 back 参数本来就支持这件事（复制模式
  // 在用）。压缩与否不在这里决定：那是 rpc 载荷层的事（见 rpc-router.ts 的
  // compressHistory），这里只管产出原始快照。
  async history(name: string, seq: number, lines?: number): Promise<TermHistoryResult> {
    const { data } = await this.capture(name, { colors: true, back: lines, pinCursor: true });
    return { data, seq };
  }

  // Generalised pane export. `history()` above is the coloured full-scrollback
  // flavour; the copy paths want something different on both axes:
  //
  //   colors — OFF by default. Verified on tmux 3.6b: WITHOUT `-e` the output
  //     carries not a single SGR escape, so it is directly pasteable. `-e` is
  //     only for the on-screen seed, where xterm re-interprets the colours.
  //   back   — how many rows ABOVE the cursor to start from, i.e. "the last N
  //     rows of the session". Resolved here into `-S` against tmux's own
  //     `#{cursor_y}`:
  //
  //         -S = cursor_y - back
  //
  //     Verified on tmux 3.6b: `-S 0` is the top of the VISIBLE screen and
  //     negative values count up into scrollback, so this yields 0-or-positive
  //     while the screen is not yet full and goes negative once the start has
  //     scrolled off — measured correct in both regimes plus the mixed case.
  //
  //     Why cursor-RELATIVE instead of an absolute row from the client: the
  //     frontend's xterm and this tmux pane do NOT share a row origin. xterm's
  //     `baseY` counts its own scrollback, and after a history seed its cursor
  //     can sit at the bottom of the screen while tmux's real cursor is still
  //     near the top (tmux pads the pane with blank rows that the seed does not
  //     reproduce as cursor movement). Measured: xterm cursorY=23 against tmux
  //     cursor_y=3 for the same pane. A distance above the cursor is invariant
  //     to that skew; an absolute row is not, and silently copied the wrong
  //     slice. The frontend therefore sends a distance and tmux resolves it.
  //
  //   endBack — the OTHER end of the same ruler: how many rows above the cursor
  //     the slice STOPS at, inclusive. Omitted (the original behaviour, kept for
  //     every existing caller) means `-E -`, the bottom of the visible screen.
  //     Given both, the slice covers `back - endBack + 1` rows:
  //
  //         -S = cursor_y - back      -E = cursor_y - endBack
  //
  //     This is what makes copy mode's "load 200 more rows" pagination possible
  //     at all: with the end pinned to the bottom, every page would re-ship
  //     everything already on screen. Verified on tmux 3.6b that adjacent
  //     ranges tile exactly — `-S -50 -E -41` and `-S -100 -E -91` are ten rows
  //     each with no overlap and no gap.
  //
  // `back`/`endBack` are validated rather than trusted: they cross the wire, and
  // a NaN or a float would be pasted into argv as garbage. Anything rejected
  // degrades to the full capture — strictly more data, never an error. An
  // `endBack` above `back` (an inverted range) is rejected the same way; without
  // a valid `back` there is no ruler to measure it against, so it is ignored.
  //
  // atTop tells the client "there is nothing older than this page", and it has
  // to be computed HERE because neither of the obvious client-side proxies
  // works (both measured on tmux 3.6b):
  //
  //   - "fewer lines came back than I asked for" is wrong because `-J` JOINS
  //     tmux-folded rows, so a 6-row request on a 40-column pane legitimately
  //     returns 4 lines of text.
  //   - "an empty page means the end" is wrong because tmux does not report
  //     going past the top. It CLAMPS: with history_size=379, `-S -900` and
  //     `-S -379` return the same oldest row, so a client walking upwards would
  //     silently re-render duplicates forever.
  //
  // So the oldest addressable row is asked for directly (`#{history_size}`, the
  // scrollback depth, putting the oldest row at `-S -history_size`) and the
  // range is compared against it. A range that starts at or above that row is
  // the last page; a range whose END is already above it does not exist at all
  // and returns empty rather than tmux's clamped duplicate.
  //
  // Overshoot downward (measured): overshooting POSITIVE (past the bottom)
  // yields an EMPTY capture, exit 0 — a stale anchor degrades to "nothing to
  // copy" rather than the wrong text.
  //
  // Async for the same reason history() is: a large capture through the SYNC
  // runner blocks Bun's event loop and freezes output for every other session.
  async capture(
    name: string,
    opts?: { colors?: boolean; back?: number; endBack?: number; pinCursor?: boolean },
  ): Promise<{ data: string; atTop: boolean }> {
    const b = opts?.back;
    const e = opts?.endBack;
    const valid = (n: unknown): n is number =>
      typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= CAPTURE_BACK_LIMIT;
    const wants = valid(b);
    // The end is only meaningful inside a valid range, and must not sit ABOVE
    // the start (endBack counts upward, so a larger value is EARLIER).
    const wantsEnd = wants && valid(e) && (e as number) <= (b as number);
    let from = "-";
    let to = "-";
    let cursor: { x: number; y: number } | null = null;
    // Without a start row the capture is the whole scrollback, which is by
    // definition already at the top.
    let atTop = true;
    // `pinCursor` 也要查：不带 back 的重灌同样要摆光标（见 withCursorFix）。
    if (wants || opts?.pinCursor) {
      // tmux is the only authority on where its cursor is and how deep its
      // history goes; ask it, and fall back to the full capture if the query
      // fails (dead pane, missing tmux).
      const q = await this.tmuxAsync([
        "display-message", "-p", "-t", name, "#{cursor_x}|#{cursor_y}|#{history_size}",
      ]);
      // 严格解析：空字段不能当 0。`Number("")` 是 0，回复少一个字段就会被读成
      // 「光标在 (0,0)」，于是往快照尾巴上补一条 `ESC[1;1H` 把光标扔到左上角
      // —— 比不补还糟。字段缺失一律按「查不到」处理，退回原样。
      const parts = new TextDecoder().decode(q.stdout).trim().split("|");
      const num = (v?: string) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : Number.NaN);
      const cx = num(parts[0]);
      const y = num(parts[1]);
      const hist = num(parts[2]);
      if (q.exitCode === 0 && Number.isFinite(y)) {
        cursor = { x: Number.isFinite(cx) ? cx : 0, y };
        if (!wants) { /* 不带 back：范围仍是全量，只是拿到了光标 */ }
        else {
        const start = y - (b as number);
        from = String(start);
        // 没有显式终点时取到**可视区底部**（`-E -`），再由 withCursorFix 补一条 CUP
        // 把光标摆回 tmux 说的位置。两件事缺一不可，理由见那个函数的注释。
        to = wantsEnd ? String(y - (e as number)) : "-";
        if (Number.isFinite(hist)) {
          const oldest = -hist; // `-S -history_size` is the oldest addressable row
          atTop = start <= oldest;
          // The whole range sits above the oldest row: tmux would clamp and hand
          // back a duplicate of the top, so answer honestly with nothing.
          if (wantsEnd && y - (e as number) < oldest) return { data: "", atTop: true };
        }
        }
      }
    }
    const args = ["-u", "capture-pane"];
    if (opts?.colors) args.push("-e");
    args.push("-p", "-J", "-S", from, "-E", to, "-t", name);
    const res = await this.tmuxAsync(args);
    if (res.exitCode !== 0) return { data: "", atTop: true };
    // 只有重灌（history）那条路径补光标定位。**复制/导出路径绝不能补**：
    // App.svelte 的复制也是「有 back 无 endBack」，补进去就是往用户剪贴板里塞
    // 一段转义序列。分页取历史（有显式终点）同样不补——那份不接实时流。
    const body = opts?.pinCursor && !wantsEnd && cursor
      ? withCursorFix(res.stdout, cursor)
      : res.stdout;
    return { data: toB64(body), atTop };
  }

  /**
   * 当前**可视区**的纯文本行（不含 scrollback、不含 SGR）——屏幕对拍的 tmux 真值侧。
   *
   * 与 history()/capture() 的区别是刻意的：
   *   - 不给 `-S`：只要当前这一屏。对拍要比的是「此刻屏幕上应该是什么」；
   *   - 不给 `-e`：颜色不参与比对。渲染漏画丢的是字符，SGR 只会制造假差异；
   *   - 不给 `-J`：保持屏幕格原样。**注意这条的理由在 2026-08-22 变过**：最初
   *     写的是「反折会让行号错位」，那是按位置比对时代的顾虑；判据改成集合比对
   *     （见 screen-diff.ts）后行号已不参与，留着不反折只是因为它更接近「屏幕上
   *     此刻是什么」，且实测 `-J` 与否对内容集合无实质差别。
   *
   * 只在诊断路径（diag.screen）上被调用，不进任何热路径。
   */
  /**
   * 已沉降的 scrollback 的最后 `n` 行（**不含当前屏**）。
   *
   * `-S -n -E -1`：tmux 的 -S/-E 以可视区顶部为 0、负数往历史里数，所以
   * `-E -1` 正好停在当前屏上面一行 —— 拿到的全是不再变化的历史。刻意排除当前屏：
   * 那里 CC 的 spinner/计时器逐帧在变，拿它对拍必然假阳。
   *
   * 不给 `-J`：要的是物理行，与客户端 buffer 的行一一对应；`-J` 会把折行合并成
   * 逻辑行，两边行的划分就不同了（复制路径用 -J 是另一回事，那里要的是可读文本）。
   */
  async scrollbackLines(name: string, n: number): Promise<string[]> {
    const lines = Math.max(1, Math.min(2000, Math.floor(n)));
    const res = await this.tmuxAsync([
      "-u", "capture-pane", "-p", "-S", `-${lines}`, "-E", "-1", "-t", name,
    ]);
    if (res.exitCode !== 0) return [];
    const text = new TextDecoder().decode(res.stdout);
    const out = text.split("\n");
    if (out.length > 0 && out[out.length - 1] === "") out.pop();
    return out;
  }

  async visibleLines(name: string): Promise<string[]> {
    const res = await this.tmuxAsync(["-u", "capture-pane", "-p", "-t", name]);
    if (res.exitCode !== 0) return [];
    const text = new TextDecoder().decode(res.stdout);
    // capture-pane 的输出以 \n 结尾，split 后末尾会多一个空串；去掉它，
    // 否则 tmuxLines 恒比真实行数多 1，底部对齐会整体错开一行。
    const lines = text.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines;
  }

  // Snapshot of the tmux pane's current state. Used by the frontend to decide
  // whether an alternate-screen buffer is a shell (stay in normal scrollback,
  // seed history) or a full-screen app (3x virtual rows + outer scrolling).
  paneInfo(name: string): { currentCommand: string; alternateOn: boolean; isShell: boolean } {
    const res = this.tmux(["display-message", "-p", "-t", name, "#{pane_current_command}|#{alternate_on}"]);
    if (res.exitCode !== 0) return { currentCommand: "", alternateOn: false, isShell: false };
    const [cmd = "", alt = ""] = new TextDecoder().decode(res.stdout).trim().split("|");
    const command = cmd.trim();
    const shellNames = new Set(["zsh", "bash", "fish", "sh", "csh", "ksh", "tcsh", "dash"]);
    return {
      currentCommand: command,
      alternateOn: alt.trim() === "1",
      isShell: shellNames.has(command),
    };
  }

  // Force tmux to re-push the pane's current screen to every attached client.
  // Used right after the frontend switches xterm into its alternate buffer:
  // tmux never forwards 1049h/1049l to attach clients, so the client-side
  // buffer switch leaves xterm's (empty) alt buffer blank until the pane app
  // redraws on its own — vim doesn't (the "vim opens to a blank screen" bug).
  // refresh-client makes tmux re-send the current grid; verified on tmux 3.6b
  // (client tty byte stream grows, screen text reappears). Gentler than the
  // resize-jiggle fallback (cols±1 -> SIGWINCH -> full repaint), so the jiggle
  // is not used. Read-only: it changes no session/pane state.
  // 「刷新」按钮：让窗格里的程序重画一屏。
  //
  // 【2026-08-25】原来是给每个 attach 客户端发 refresh-client。换掉 attach 之后
  // （见 openChannel）我们不再是 tmux 的客户端，list-clients 通常为空，那条路
  // 恒返回 false。改用**尺寸抖动**：cols-1 再 cols，让 tmux 给窗格发 SIGWINCH，
  // 程序自己重绘 —— 那才是真正的窗格输出、才会走到 pipe-pane 里来。
  //
  // 实测（spike/redraw-jiggle-probe.ts）：vim 增长 2768B、less 1624B，两次 resize
  // 相隔 0/50/200ms 结果一致（SIGWINCH 合并不构成问题）。**但对不处理 SIGWINCH 的
  // 程序（shell 提示符、cat 出来的静态文本）它什么也不做** —— 那种情况下前端应当
  // 走 capture-pane 重新播种，而不是指望这里。所以 ok 只表示「抖动发出去了」。
  redraw(name: string): { ok: boolean } {
    const live = this.sessions.get(name);
    if (!live) return { ok: false };
    const { cols, rows } = live.meta;
    if (cols <= 1) return { ok: false };
    const a = this.tmux(["resize-window", "-t", name, "-x", String(cols - 1), "-y", String(rows)]);
    const b = this.tmux(["resize-window", "-t", name, "-x", String(cols), "-y", String(rows)]);
    return { ok: a.exitCode === 0 && b.exitCode === 0 };
  }

  // The focused pane's real working directory (tmux #{pane_current_path}).
  // Used by the file panel's "set project root to focused tab" button. `-u`
  // forces UTF-8 so CJK path segments aren't sanitized under a C locale.
  pwd(name: string): { pwd: string } {
    const res = this.tmux(["-u", "display-message", "-p", "-t", name, "#{pane_current_path}"]);
    if (res.exitCode !== 0) return { pwd: "" };
    return { pwd: new TextDecoder().decode(res.stdout).trim() };
  }

  // 打开窗格通道并接好字节/退出回调。
  //
  // 【2026-08-25 换掉了 `tmux attach`】原来这里 spawn 一个 attach 客户端，转发它的
  // 字节。那是 tmux **画给客户端的重绘流**：备用屏 + 绝对定位，没有 scrollback，
  // 而我们重连时又要塞 capture-pane 快照，两套行网格一错开，tmux 的绝对定位就把
  // 手机上的内容覆盖掉 —— 「终端中间丢行」的根因。详见 pane-channel.ts 头部。
  // 现在改成 pipe-pane 取窗格原始字节（相对定位、无备用屏），输入走 send-keys。
  private openChannel(name: string, cols: number, rows: number): PtyHandle {
    const ch = new PaneChannel(name, { tmux: this.tmux, tmuxAsync: this.tmuxAsync });
    ch.onData((chunk) => {
      const live = this.sessions.get(name);
      if (live) live.lastOutputAt = Date.now();
      for (const cb of this.outputCbs) cb(name, chunk);
    });
    ch.onExit((code) => this.onPtyExit(name, code));
    ch.resize(cols, rows);
    return ch;
  }

  // tmux session is the source of truth: a dead PTY may just be a detach.
  private onPtyExit(name: string, code: number): void {
    const live = this.sessions.get(name);
    if (!live) return; // already killed locally

    if (this.hasSession(name)) {
      // Session still alive -> this was a detach. Guard against a hot loop if
      // has-session flaps by demoting to "done" when re-attaches come too fast.
      const now = Date.now();
      if (now - (live.lastReattachAt ?? 0) < 500) {
        this.sessions.delete(name);
        this.states.delete(name);
        for (const cb of this.exitCbs) cb(name, code);
        this.emitSessionsChange();
        return;
      }
      live.lastReattachAt = now;
      // 先关旧通道再开新的：新通道构造时会 unlink 并重建同名 FIFO，旧通道若还
      // 开着，它的流就悬在被删掉的旧 inode 上，永远收不到字节（见 scanAsync 的
      // 纪律 2）。
      live.pty.kill();
      live.pty = this.openChannel(name, live.meta.cols, live.meta.rows);
      return;
    }

    this.reap(name, code);
  }

  /** 会话确认没了：清账并通知。onPtyExit 与扫描器共用同一条收尸路径。 */
  private reap(name: string, code: number): void {
    const live = this.sessions.get(name);
    live?.pty.kill();
    this.sessions.delete(name);
    this.states.delete(name);
    for (const cb of this.exitCbs) cb(name, code);
    this.emitSessionsChange();
  }

  ensure(
    name: string,
    opt: { cmd?: string; cwd?: string; cols?: number; rows?: number; env?: Record<string, string> } = {},
  ): void {
    if (this.sessions.has(name)) return;

    const cols = opt.cols ?? 80;
    const rows = opt.rows ?? 24;

    const exists = this.hasSession(name);
    if (!exists) {
      // `-u`: create the tmux server in UTF-8 mode so panes store/parse CJK
      // correctly regardless of the (often absent under launchd) locale. See attach().
      const args = ["-u", "new-session", "-d", "-s", name];
      // `-e`: seed the session environment so the shell (and any `claude` it
      // launches) inherit CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1. This forces
      // Claude Code into its classic renderer, which keeps the full transcript in
      // the NORMAL buffer (native scrollback) instead of a scrollback-less
      // alternate screen — so a long plan (hundreds of lines) is scrollable on the
      // phone and the input line stays visible. Also dodges the fullscreen
      // renderer's CJK-copy-corruption bug. (tmux 3.0+; `-e` before the command.)
      args.push("-e", "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1");
      // `-e TERMUX_VERSION=1`: Reasonix (the DeepSeek agent CLI) only offers its
      // mobile-friendly renderer ("nativeScrollback": no alt-screen, no mouse
      // capture, transcript printed into the normal buffer) when it detects a
      // Termux terminal via TERMUX_VERSION / TERMUX_APP_PID / TERMUX__PREFIX.
      // Our sessions are not Termux, so seed the variable to make Reasonix take
      // that path — same mechanism as the Claude Code seed above, so touch
      // scrollback works on the phone. Verified zero impact on the other tools
      // that share these sessions: Claude Code gates every TERMUX_VERSION read
      // on `TERMUX_VERSION && PREFIX` (PREFIX stays unset here), and Codex has
      // no TERMUX references at all. See docs/reasonix-移动端手势滚动问题.md.
      args.push("-e", "TERMUX_VERSION=1");
      // Notification hook wiring: seed POCKETSHELL_NOTIFY_* so a hook running
      // inside this session can identify it as a PocketShell session and POST to
      // the loopback notify endpoint. Absent outside PocketShell => hook exits 0.
      for (const [k, v] of Object.entries(opt.env ?? {})) args.push("-e", `${k}=${v}`);
      // `-e LANG=...`: a pane program's locale (what `vim`/the shell see) is
      // decided by the tmux SERVER's `new-session` environment, not by any
      // flag on the attach CLIENT — `-u` above only makes the attach client
      // itself UTF-8-aware, it does not reach the pane. Under launchd there is
      // no LANG/LC_* at all, so without this the pane runs in the C locale and
      // vim/CJK input gets garbled even though attach() looks correct. Only
      // seed a fallback when the agent's own env has no locale, so an operator
      // who explicitly configured one is never overridden (see cjkFallbackLang).
      if (this.langFallback) args.push("-e", `LANG=${this.langFallback}`);
      if (opt.cwd) args.push("-c", opt.cwd);
      if (opt.cmd) args.push(opt.cmd);
      const res = this.tmux(args);
      if (res.exitCode !== 0) {
        throw new Error(
          `tmux new-session failed for "${name}": ${new TextDecoder().decode(res.stderr)}`,
        );
      }
    }

    // Disable tmux's default status line (server-wide, idempotent). Two mobile
    // bugs both trace to it: (1) its green bar occupies the window's bottom row
    // and visually covers the shell prompt/input on the phone — and the app
    // already renders its own session tabs + connection status, so tmux's status
    // line is redundant; (2) its right side shows a clock that tmux redraws every
    // `status-interval` (15s default) — the only idle output tmux emits — which
    // periodically nudged the cursor down a row. With status off the window is a
    // clean 1:1 with xterm's rows and there is no periodic redraw.
    this.tmux(["set-option", "-g", "status", "off"]);

    const meta: SessionMeta = {
      name,
      kind: "tmux",
      state: "run",
      cols,
      rows,
      lastLine: "",
      createdAt: Date.now(),
      attached: true,
    };
    const pty = this.openChannel(name, cols, rows);
    this.sessions.set(name, { pty, meta, lastOutputAt: Date.now() });
    this.states.set(name, new StateHysteresis("run"));
    this.emitSessionsChange();
  }

  // Public liveness check across owned + any live tmux session (foreign
  // included). Used by the server to reject a shell session whose name would
  // collide with an existing tmux session (cross-service name uniqueness).
  has(name: string): boolean {
    return this.sessions.has(name) || this.hasSession(name);
  }

  write(name: string, data: Uint8Array): void {
    this.sessions.get(name)?.pty.write(data);
  }

  resize(name: string, cols: number, rows: number): void {
    const live = this.sessions.get(name);
    if (!live) return;
    live.meta.cols = cols;
    live.meta.rows = rows;
    live.pty.resize(cols, rows);
    this.tmux(["resize-window", "-t", name, "-x", String(cols), "-y", String(rows)]);
  }

  async kill(name: string): Promise<void> {
    const live = this.sessions.get(name);
    live?.pty.kill();
    this.sessions.delete(name);
    this.states.delete(name);
    this.tmux(["kill-session", "-t", name]);
    this.emitSessionsChange();
  }

  rename(name: string, newName: string): void {
    const live = this.sessions.get(name);
    if (!live) {
      // Foreign (non-owned) session: rename directly; next list() reflects it.
      const res = this.tmux(["rename-session", "-t", name, newName]);
      if (res.exitCode !== 0) {
        throw new Error(
          `tmux rename-session failed for "${name}": ${new TextDecoder().decode(res.stderr)}`,
        );
      }
      this.emitSessionsChange();
      return;
    }
    const res = this.tmux(["rename-session", "-t", name, newName]);
    if (res.exitCode !== 0) {
      throw new Error(
        `tmux rename-session failed for "${name}": ${new TextDecoder().decode(res.stderr)}`,
      );
    }
    live.meta.name = newName;
    this.sessions.delete(name);
    this.sessions.set(newName, live);
    const m = this.states.get(name);
    this.states.delete(name);
    if (m) this.states.set(newName, m);
    // Re-wire the PTY so its onData/onExit closures capture the new name;
    // otherwise output for this session keeps being emitted under the old name
    // and the client (now keyed by the new name) receives nothing.
    live.pty.kill();
    live.pty = this.openChannel(newName, live.meta.cols, live.meta.rows);
    this.emitSessionsChange();
  }

  // Whole-machine tmux roster (one spawn). Tab-separated; session names cannot
  // contain a tab in practice, so a plain split is safe. Degrades to [] when
  // tmux is absent or the query fails.
  //
  // `-u` is REQUIRED, not cosmetic: without it, tmux under launchd (no LANG/LC_*
  // -> C locale) sanitizes the literal TAB delimiter in `-F` output to `_`, so
  // every line fails the 4-field split and the whole roster comes back empty
  // (the "task panel is empty in production" bug). Same root cause as the
  // CJK-underscore fix on attach()/new-session. Do not remove `-u`.
  private async roster(): Promise<TmuxRosterEntry[]> {
    const res = await this.tmuxAsync([
      "-u",
      "list-sessions",
      "-F",
      "#{session_name}\t#{session_created}\t#{window_width}\t#{window_height}",
    ]);
    if (res.exitCode !== 0) return [];
    return new TextDecoder()
      .decode(res.stdout)
      .split("\n")
      .map((l) => l.replace(/\s+$/, ""))
      .filter((l) => l.length > 0)
      .map((l): TmuxRosterEntry | null => {
        const parts = l.split("\t");
        if (parts.length < 4) return null;
        const [name, created, width, height] = parts;
        return {
          name,
          createdAt: (Number(created) || 0) * 1000,
          cols: Number(width) || 80,
          rows: Number(height) || 24,
        };
      })
      .filter((e): e is TmuxRosterEntry => e !== null);
  }

  // Async + concurrent (WP-3a): the roster spawn runs alongside per-session
  // capture-pane probes (Promise.all), so a round costs ~1 spawn round-trip
  // instead of 2S+1+F serialized spawnSyncs that blocked the event loop.
  // Owned sessions report the scanner-debounced state instead of re-probing
  // has-session per call: the 1s scanner already tracks liveness, and a fresh
  // raw inference here would reintroduce the run/wait flap the hysteresis
  // just filtered out.
  async list(): Promise<SessionMeta[]> {
    const rosterP = this.roster();
    const owned = await Promise.all(
      [...this.sessions.values()].map(async (l) => ({
        ...l.meta,
        state: this.states.get(l.meta.name)?.state ?? l.meta.state,
        lastLine: await this.captureLastLine(l.meta.name),
        attached: true,
      })),
    );
    const foreign = await Promise.all(
      (await rosterP)
        .filter((r) => !this.sessions.has(r.name))
        .map(async (r) => ({
          name: r.name,
          kind: "tmux" as const,
          state: "idle" as const,
          cols: r.cols,
          rows: r.rows,
          lastLine: await this.captureLastLine(r.name),
          createdAt: r.createdAt,
          attached: false,
        })),
    );
    return [...owned, ...foreign];
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.scanTimer);
    for (const l of this.sessions.values()) l.pty.kill();
    this.sessions.clear();
    this.states.clear();
  }
}
