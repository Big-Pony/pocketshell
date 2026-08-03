<script module lang="ts">
  // R1 (hidden terminals) buffering lives in ../lib/pending-buffer.ts — pure
  // logic, re-exported here so existing importers of this component keep working.
  import { PendingBuffer } from "../lib/pending-buffer";
  export { PendingBuffer };

  // xterm's theme takes literal colour strings, not CSS variables. Read the
  // --term-* tokens off :root so app.css stays the single source of truth for
  // the palette (a reskin that only edits app.css can't miss the terminal).
  // Falls back to the dark values when the tokens are missing (SSR / bare test
  // DOM), which is also what the terminal always is in every theme.
  //
  // Cursor and selection read --term-* rather than --accent/--code-selection:
  // the terminal is dark under every theme, but a light theme's accent and
  // selection are tuned for a light background (dimmed for contrast there), so
  // borrowing them here gives a dark cursor and a barely-visible selection.
  export function termTheme(): { background: string; foreground: string; cursor: string; selectionBackground: string } {
    const read = (name: string, fallback: string): string => {
      if (typeof getComputedStyle !== "function") return fallback;
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    };
    return {
      background: read("--term-bg", "#1b1d20"),
      foreground: read("--term-text", "#cfd2cd"),
      cursor: read("--term-accent", "#ff4d00"),
      selectionBackground: read("--term-selection", "rgba(255, 77, 0, 0.26)"),
    };
  }
</script>

<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { WebglAddon } from "@xterm/addon-webgl";
  import { installWebgl, type WebglHandle } from "../lib/webgl-renderer";
  import { snapshotAtlas, formatSnapshot } from "../lib/atlas-probe";
  import { Connection } from "../lib/connection";
  import { fromB64 } from "../lib/bytes";
  import type { TermHistoryResult } from "../lib/protocol";

  let {
    conn,
    sessionId,
    active,
    closed = false,
    fontSize = 14,
    onReady,
  }: {
    conn: Connection;
    sessionId: string;
    active: boolean;
    closed?: boolean;
    fontSize?: number;
    onReady?: (sessionId: string, term: Terminal) => void;
  } = $props();

  let host: HTMLDivElement;
  let term: Terminal;
  let fit: FitAddon;
  // Plain `let term/fit` are NOT reactive — a visibility $effect keyed on them
  // would never re-fire after onMount assigns them, so for an initially-active
  // terminal startPoll would never run (the first classify then only fires on
  // an input burst, landing reloadHistory mid-typing and nuking any selection).
  // This flag is the reactive "setup complete" signal for that effect.
  let mounted = $state(false);

  // Assigned in onMount; the visibility $effect below drives suspend/resume
  // through it, so it has to outlive onMount's closure (same reason as refit).
  let webglHandle: WebglHandle | undefined;

  // Assigned in onMount; callable from $effect blocks that react to active/font.
  let refit: () => void = () => {};
  // Same lifecycle as refit: flushes/reseeds the output stashed while hidden.
  let flushPending: () => void = () => {};
  // Same lifecycle again: start/pause the classifyPane poll with visibility
  // (A4 — only the active, live session polls tmux).
  let startPoll: () => void = () => {};
  let stopPoll: () => void = () => {};
  // Same lifecycle as refit: forces a resize resend on activation even when this
  // device's xterm dims are unchanged (需求2 — re-assert THIS device's size on a
  // shared tmux session another device resized), then redraws to fill it.
  let activateRefit: () => void = () => {};

  // Which tmux buffer the pane is in, driven by tmux's real alternate_on state.
  // Shells AND classic-renderer Claude Code live in the normal buffer (native
  // scrollback); only genuine full-screen apps (vim/htop) use the alternate
  // buffer. Claude Code is forced into its classic renderer via
  // CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 (agent-side), so its long output
  // lands in scrollback that the phone can scroll natively.
  type PaneMode = "normal" | "alt";
  type BufferType = "normal" | "alternate";

  // onMount below is async (font preload), and Svelte only registers a cleanup
  // returned SYNCHRONOUSLY — so teardown goes through onDestroy + this slot,
  // assigned once setup completes. Without it an unmounted terminal would keep
  // its resize listener and poll interval alive forever.
  let teardown: (() => void) | undefined;
  let destroyed = false;
  onDestroy(() => {
    destroyed = true;
    teardown?.();
  });

  onMount(async () => {
    // Ensure the bundled JetBrains Mono is ready before xterm measures cells.
    // Falls back silently if the font is unavailable or the API is missing.
    try {
      await document.fonts.load(`${fontSize}px "JetBrains Mono"`);
    } catch {
      // ignore
    }
    if (destroyed) return; // unmounted while the font loaded — set nothing up

    term = new Terminal({
      fontSize,
      // Defensive CJK fallback: JetBrains Mono has no CJK glyphs, so name OS CJK
      // fonts (PingFang SC / Noto Sans CJK / YaHei) so a device whose generic
      // `monospace` lacks CJK still renders Chinese. Latin/box-drawing keep
      // hitting JetBrains Mono first. NOTE: the actual "Chinese shows as an
      // underscore on the phone" bug was NOT a font issue — it was tmux running
      // without a UTF-8 locale under launchd; fixed by `tmux -u` in
      // agent/src/terminal.ts. This chain is kept as a belt-and-suspenders.
      fontFamily: '"JetBrains Mono", "SF Mono", ui-monospace, Menlo, Monaco, Consolas, "Cascadia Code", "Cascadia Mono", "Liberation Mono", "Courier New", "PingFang SC", "Hiragino Sans GB", "Heiti SC", "Noto Sans CJK SC", "Noto Sans SC", "Source Han Sans SC", "Microsoft YaHei", "WenQuanYi Micro Hei", "Droid Sans Fallback", "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", monospace',
      // 对齐 tmux 的 history-limit（2000）：capture-pane 最多就吐这么多行，
      // 多出的配额只会白占内存（xterm.js#791 实测 160×24 + 5000 行 ≈ 34MB）。
      // 若日后调大 tmux history-limit，这里要同步调大，否则历史会被 xterm 截断。
      scrollback: 2000,
      unicodeVersion: "11",
      convertEol: false,
      cursorBlink: true,
      disableStdin: true,
      // 手机上「看不见输入光标」的修复。这个面板永远拿不到焦点：它是只读的
      // （disableStdin），且为了压掉手机 IME，xterm 那个隐藏 helper textarea 被设成
      // readOnly + tabindex=-1 并主动 blur（见下方 IME 段）。xterm 的 isFocused 正是
      // 从这个 textarea 的 focus/blur 推出来的，所以这里恒为 false —— 渲染器画的
      // 永远是 cursorInactiveStyle，cursorStyle 根本用不上。
      //
      // xterm 默认的 inactive 样式是 "outline"：只有 1 个设备像素宽的空心细框。
      // 这条在 xterm 5.5 时代就成立，但那时没有 DECSCUSR；6.0 起光标样式改为
      // `decPrivateModes.cursorStyle ?? options.cursorStyle`，Claude Code 这类 TUI
      // 发的 `CSI Ps SP q` 会被采纳，叠加上细框后光标在手机上实际不可见。
      // 要控制这个面板，改的必须是 INACTIVE 那一个。
      cursorInactiveStyle: "block",
      // 但只改样式还不够：xterm 默认要等「首次获得焦点或首次键盘输入」才把
      // isCursorInitialized 置位（CoreBrowserTerminal._showCursor 的三个调用点分别在
      // textarea focus / keydown / keypress 里），在那之前光标压根不会进渲染模型 ——
      // 而这三条路本面板一条都走不到。xterm 6.0 新增的 showCursorImmediately 正是
      // 为这种「外部驱动输入」的只读终端准备的：跳过那道闸，开局就画光标。
      // 5.5.0 没有这个选项，所以升级前是靠别的路径蒙对的；实测（A/B 对比）只加
      // cursorInactiveStyle 而不加这条，cursor model 恒为 undefined、屏幕上没有光标。
      showCursorImmediately: true,
      // 终端区两套主题均为深色。xterm 只吃字面色值、不认 CSS 变量，所以在这里
      // 把 --term-* 读出来喂给它——换肤时改 app.css 一处即可，不会再漏这里。
      theme: termTheme(),
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    // 渲染器：默认的 DOM 渲染器每个字符一个 <span>，2000 行 × 80 列 ≈ 16 万节点，
    // 是「打开大输出会话卡十几秒」的耗时主项。WebGL 走 GPU 纹理图集，快一个量级。
    // 必须能静默回落：不支持 WebGL2 的设备（旧安卓、关了硬件加速的浏览器）若让
    // 异常冒出去会白屏，而 DOM 渲染器虽慢但永远可用——installWebgl 内部吞掉
    // 构造异常，返回一个 active:false 的句柄即可。
    //
    // GPU 上下文丢失（手机长时间使用后系统回收显存）的恢复规则见
    // lib/webgl-renderer.ts。这里只提供两个钩子：怎么造一个新 addon，以及
    // 恢复后拿什么重画屏幕（reloadHistory —— 上下文死掉期间到达的字节没有任何
    // 渲染器接住，屏上内容不可信，必须从 tmux 重灌）。
    //
    // 注意：webglHandle 在 onMount 里赋值，但 teardown 在下面才组装，两者都在
    // 同一个闭包里，所以这里用 let + 后面 dispose 即可。
    // 当前挂着的 addon，仅供诊断埋点读取图集状态用（重建时会被换掉，所以不能
    // 在闭包里存第一次那个）。恢复逻辑本身走 webglHandle，不碰这个引用。
    let webglAddon: WebglAddon | undefined;
    webglHandle = installWebgl({
      create: () => {
        const addon = new WebglAddon();
        term.loadAddon(addon);
        webglAddon = addon;
        return addon;
      },
      // reloadHistory 声明在下面（const 提升到同一函数作用域内的 TDZ 之后才被
      // 调用——上下文丢失最早也要等 3 秒，早已越过 onMount 同步段）。
      reseed: () => { void reloadHistory(); },
      log: (m) => console.warn(m),
      // 隐藏挂载的终端一开始就不拿上下文：已经开着几个 tab 时再开一个新会话，
      // 若隐藏挂载也建上下文，几下就能顶到上限。可见性由下面的 $effect 接管。
    }, undefined, !(active && !closed));

    // 只有可见的 tab 持有 WebGL 上下文（docs/bug/终端显示异常2）。
    //
    // 根因是实测出来的：浏览器对每页存活的 WebGL 上下文数有硬上限，超了就强制
    // 杀掉最老的那个。Chrome 里第 1..16 个终端全部存活，从第 17 个开始每多一个
    // 就恰好死掉一个更老的，存活数钉死在 16；手机限额低得多，所以你开几个窗口
    // 就中招。原来每个 tab 挂一个活的 TerminalView = 每个 tab 一个上下文，于是
    // 老 tab 的渲染器被浏览器悄悄杀掉——「必须多开才出现」「有的 tab 正常有的
    // 冻住」「只有关掉全部 tab 才恢复」全都是这一条。
    //
    // 隐藏的终端本来就不渲染，占着上下文没有任何收益，却在消耗唯一真正稀缺的
    // 资源。下面那个 $effect 跟着 active 走：切走就 suspend，切回就 resume。
    //
    // 注意这里不再监听 visibilitychange 做纹理重传（旧的 48e1ee1 方案）——那修
    // 的是错的根因，上下文都被杀了，往死掉的上下文里清纹理没有意义。
    //
    // 诊断上报保留：回前台时把图集状态发回 agent 打进日志（launchd 已把 agent
    // stdout 落到 ~/Library/Logs/pocketshell/agent.out.log）。这个 App 的使用场景
    // 就是「手边没有电脑」，指望用户在现场连 devtools 抄日志不现实，而 agent 跑
    // 在用户自己机器上，回到电脑前翻日志就行。上报是尽力而为，链路断了只是少一
    // 条诊断，绝不能影响任何别的东西。
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      try {
        const snap = snapshotAtlas(webglAddon, true);
        console.warn(formatSnapshot(sessionId, snap));
        void conn.rpc("diag.report", { tag: sessionId, kind: "atlas", ...snap }).catch(() => {});
      } catch { /* 诊断绝不能影响任何东西 */ }
    };
    document.addEventListener("visibilitychange", onVisible);
    // Mobile IME fix: xterm focuses a hidden helper textarea on tap; if it stays
    // editable the phone keyboard pops up (and, because our on-screen keys
    // preventDefault focus-steal, never leaves). xterm is display-only here
    // (disableStdin:true), so make the helper textarea non-editable + inputmode
    // none so tapping the terminal never raises the system IME.
    const helper = host.querySelector("textarea.xterm-helper-textarea") as HTMLTextAreaElement | null;
    if (helper) {
      helper.readOnly = true;
      helper.setAttribute("inputmode", "none");
      helper.setAttribute("tabindex", "-1");
      helper.blur();
    }
    // Desktop selection: this pane is display-only (disableStdin) and the ops
    // panel selects via term.select(), so xterm's own mouse-drag selection is
    // redundant. Swallow mousedown in the capture phase (before xterm's listeners
    // on .xterm/.xterm-screen) so the browser's native selection takes over —
    // smartCopy already reads window.getSelection(). Mobile long-press selection
    // is NOT handled here: xterm hijacks touch into scrolling and can't be
    // reliably worked around, so it's done by the copy-mode overlay
    // (TermCopyOverlay) which selects a listener-free clone of the rows instead.
    host.addEventListener("mousedown", (e) => { e.stopPropagation(); }, true);
    fit.fit();

    // Buffer the pane is in; gates history seeding (only in the normal buffer).
    let currentBuffer: BufferType = "normal";

    const dims = () => fit.proposeDimensions() ?? { cols: term.cols, rows: term.rows };

    // Size xterm + the PTY 1:1 with the visible viewport. Long output is handled
    // by the normal buffer's native scrollback (Claude Code runs in its classic
    // renderer, so its transcript accumulates in scrollback instead of a fixed
    // alt-screen). No virtual-row inflation → the input line stays the last row
    // and the cursor stays visible (no scroll-to-find-the-cursor).
    // R3: the size the PTY was last told about. conn.resize only goes out on a
    // real change — a duplicate frame is a wasted wake on the link, and the
    // agent raises SIGWINCH (with its full-screen redraw storm) only when the
    // size actually differs.
    let lastSentCols = 0;
    let lastSentRows = 0;
    refit = () => {
      const d = dims();
      if (term.cols !== d.cols || term.rows !== d.rows) term.resize(d.cols, d.rows);
      // proposeDimensions can over-count by ~1 col on narrow mobile viewports
      // (padding/scrollbar rounding), clipping the rightmost cells off-screen.
      // Shrink a column at a time until the rendered screen fits the host width.
      const screen = host.querySelector(".xterm-screen") as HTMLElement | null;
      let guard = 4;
      while (screen && screen.scrollWidth > host.clientWidth && term.cols > 20 && guard-- > 0) {
        term.resize(term.cols - 1, term.rows);
      }
      if (term.cols !== lastSentCols || term.rows !== lastSentRows) {
        lastSentCols = term.cols;
        lastSentRows = term.rows;
        conn.resize(sessionId, term.cols, term.rows);
      }
    };

    // R1: while hidden, stash raw bytes instead of writing to xterm (parse +
    // render is the expensive part); activation flushes them in one write.
    // Tombstoned sessions get no live stream anymore — drop their frames.
    const pendingOut = new PendingBuffer();
    const unsubscribeOutput = conn.onOutput((f) => {
      if (f.sessionId !== sessionId) return;
      if (active) { term.write(f.data); return; }
      if (closed) return;
      pendingOut.push(f.data);
    });

    // Seed tmux history into the shell's normal buffer, replacing what xterm
    // holds. Called once when the pane (re)enters shell mode and on a cols change
    // (xterm wraps history to the current width, so a resize invalidates it).
    let lastCols = term.cols;
    // 重排/回到 normal buffer 时用：清空后按当前宽度重灌整份历史。
    // 首屏 seed 不走这里（那条路不能 clear，见 seedFromHistory）。
    const reloadHistory = async () => {
      if (currentBuffer !== "normal") return;
      try {
        const h = (await conn.rpc("term.history", { session: sessionId })) as TermHistoryResult;
        term.clear();
        // capture-pane lines are trimmed and bare-\n separated; xterm runs with
        // convertEol:false, so a bare \n moves down WITHOUT returning to column
        // 0 and the reseed renders as a diagonal staircase (visible after `:q`
        // from vim, where no live repaint masks it). Normalize to \r\n.
        if (h?.data) term.write(new TextDecoder().decode(fromB64(h.data)).replace(/\n/g, "\r\n"));
      } catch { /* best-effort */ }
    };

    // 首屏 seed：拉一份快照写进空白终端，然后用快照的 seq 订阅之后的增量。
    // 与 reloadHistory 的区别有两点，都很关键：
    //   1) 不 clear —— 终端此刻本就是空的，clear 只会多一次无谓重绘；
    //   2) 结尾要 attach(seq, {seed:true}) 把实时流接上。
    // 顺序上服务端是「先取号后快照」，所以快照期间到达的输出必然 > seq，
    // 会被这次 attach 补上：宁可重叠几帧也不丢字节。
    //
    // 失败也必须 attach —— 否则首屏空白之外连实时输出都收不到。此时退回
    // attach(0)（不带 seed），走原来的 replay 重放路径兜底。
    const seedFromHistory = async () => {
      try {
        const h = (await conn.rpc("term.history", { session: sessionId })) as TermHistoryResult;
        if (h?.data) {
          term.write(new TextDecoder().decode(fromB64(h.data)).replace(/\n/g, "\r\n"));
        }
        conn.attach(sessionId, h?.seq ?? 0, { seed: true });
      } catch {
        conn.attach(sessionId);
      }
    };

    // Activation path (R1). A dirty stash means the byte stream is incomplete,
    // so replaying it would corrupt the screen: reseed from tmux instead — or,
    // in the alternate buffer where capture-pane is useless, ask the pane app
    // to repaint. Otherwise write the stashed bytes in one go.
    flushPending = () => {
      if (pendingOut.dirty) {
        pendingOut.clearDirty();
        if (currentBuffer === "normal") void reloadHistory();
        else void conn.rpc("term.redraw", { session: sessionId }).catch(() => {});
        return;
      }
      const data = pendingOut.take();
      if (data) term.write(data);
    };

    activateRefit = () => {
      // 需求2: bypass the R3 suppression guard so conn.resize goes out on every
      // activation. If the shared tmux window already matches this device the
      // agent no-ops (SIGWINCH only fires on a real size change); if another
      // device shrank it, this pulls it back and tmux repaints via the live
      // stream. No explicit reseed here — that would clear+redraw on every tab
      // switch (and double-reseed the dirty-stash case that flushPending handles).
      lastSentCols = -1;
      lastSentRows = -1;
      refit();
    };

    // Poll tmux's real alternate_on state and switch xterm's buffer to match,
    // ONLY on an actual change (edge-triggered). tmux does not forward 1049h/1049l
    // to an attach client, so we drive the buffer ourselves. Re-seeding history on
    // every poll would clear+redraw the whole screen every 2s and race the live
    // stream, so history is (re)seeded only on the edge into the normal buffer and
    // on a cols change.
    let paneInfoSeq = 0;
    // 初值给 "normal" 而不是 null：首屏已由 seedFromHistory 灌过内容了，
    // 若这里留 null，第一次 classifyPane 必然判定为「mode 变化 → normal」，
    // 从而多跑一次 reloadHistory（clear + 重写全量）—— 那正是这次要消灭的
    // 双重渲染。会话真处在 alt buffer（vim/htop）时，第一次 poll 会判定
    // normal→alt 并走 term.redraw，行为不变。
    let appliedMode: PaneMode | null = "normal";
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let classifyDebounce: ReturnType<typeof setTimeout> | undefined;
    // A4: pausing also drops a pending input-debounced classify — a hidden or
    // tombstoned session has no business polling tmux at all.
    stopPoll = () => {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = undefined; }
      if (classifyDebounce) { clearTimeout(classifyDebounce); classifyDebounce = undefined; }
    };
    const classifyPane = async () => {
      const seq = ++paneInfoSeq;
      try {
        const info = (await conn.rpc("term.paneInfo", { session: sessionId })) as {
          currentCommand: string;
          alternateOn: boolean;
          isShell: boolean;
        };
        if (seq !== paneInfoSeq) return; // stale response superseded by a newer poll
        if (typeof info.alternateOn !== "boolean") return; // malformed → keep current mode
        const mode: PaneMode = info.alternateOn ? "alt" : "normal";
        if (mode === appliedMode) return; // edge-triggered: unchanged → leave the screen alone
        appliedMode = mode;
        if (mode === "normal") {
          // Back to the normal buffer: leave any alt buffer and reseed history so
          // prior scrollback (incl. Claude Code's classic-renderer transcript) is
          // visible. The write callback fires after onBufferChange has set
          // currentBuffer = "normal", so reloadHistory won't early-return.
          term.write("\x1b[?1049l", () => { void reloadHistory(); });
        } else {
          // Switch xterm into its alternate buffer, then make tmux re-push the
          // pane's current screen (term.redraw). The pane app (vim/htop) already
          // drew its UI into tmux's alt screen, but those bytes landed in xterm's
          // NORMAL buffer before this switch — and vim never redraws unprompted,
          // so without the re-push the fresh (empty) alt buffer stays blank. The
          // write callback guarantees the buffer switch completed before the
          // re-pushed bytes arrive. Best-effort: failure keeps the 2s-poll UX.
          term.write("\x1b[?1049h", () => {
            void conn.rpc("term.redraw", { session: sessionId }).catch(() => {});
          });
        }
      } catch { /* keep current mode */ }
    };

    // A4: (re)start the 2s cadence with one immediate classify so an activated
    // tab refreshes its pane mode right away instead of waiting out the interval.
    // No-ops while already running or on a tombstoned session (closed/done).
    startPoll = () => {
      if (pollTimer !== undefined || closed) return;
      void classifyPane();
      pollTimer = setInterval(() => void classifyPane(), 2000);
    };

    // Track xterm's buffer so reloadHistory knows it's in the normal buffer.
    term.buffer.onBufferChange((buf) => {
      currentBuffer = (buf.type as BufferType) === "alternate" ? "alternate" : "normal";
    });

    // Outbound input is the strongest hint that the pane may change mode
    // (`vim x<CR>` enters the alt screen; `:q<CR>` leaves it). Re-classify
    // ~200ms after the last keystroke of a burst instead of waiting for the
    // next 2s poll, so the buffer switch + redraw feel immediate. Trailing
    // debounce keeps it to one paneInfo RPC per burst, not per keystroke.
    // A4: a tombstoned session has no live pane — never re-classify for it.
    const unsubscribeInput = conn.onInput((sid) => {
      if (sid !== sessionId || closed) return;
      if (classifyDebounce) clearTimeout(classifyDebounce);
      classifyDebounce = setTimeout(() => void classifyPane(), 200);
    });

    // Session is created by App (SessionTabs "new"); here we only seed + size.
    // Input is routed by the custom keyboard (S5b) through conn.sendInput —
    // xterm is display-only.
    //
    // 首屏走 history 快照而不是 attach 重放：tmux 的 capture-pane 是真实画面，
    // 而 replay 环形缓冲只有 256KB 且只覆盖「agent 启动以来」，接管外部或
    // 重启前的 tmux 会话时可能是空的。seedFromHistory 内部负责 attach。
    void seedFromHistory();
    refit();
    onReady?.(sessionId, term);
    // The classifyPane poll is NOT started here: the visibility $effect below
    // starts it when (and only while) this terminal is active + live (A4).

    // R3: a window resize fires continuously during a drag — collapse the burst
    // into one trailing refit (~150ms). The activation/font-size paths call
    // refit directly and stay immediate.
    let resizeDebounce: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      if (!active) return;
      if (resizeDebounce) clearTimeout(resizeDebounce);
      resizeDebounce = setTimeout(() => {
        resizeDebounce = undefined;
        refit();
        if (term.cols !== lastCols) { lastCols = term.cols; void reloadHistory(); }
      }, 150);
    };
    window.addEventListener("resize", onResize);

    // 需求7: the divider drag changes only the container height (no window
    // resize), so observe the host directly. Reuses onResize's 150ms debounce
    // + cols-change reloadHistory. Guarded for environments without RO (jsdom).
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => onResize());
      ro.observe(host);
    }

    // Theme switch repaints the terminal: the --term-* tokens differ slightly
    // between the two themes (both dark), and xterm holds a copy of the colours
    // taken at construction. Without this the terminal keeps the old background
    // until it is remounted. Guarded for jsdom (no MutationObserver in some setups).
    let themeObs: MutationObserver | undefined;
    if (typeof MutationObserver !== "undefined") {
      themeObs = new MutationObserver(() => { term.options.theme = termTheme(); });
      themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    }

    teardown = () => {
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisible);
      ro?.disconnect();
      themeObs?.disconnect();
      unsubscribeOutput?.();
      unsubscribeInput?.();
      if (resizeDebounce) clearTimeout(resizeDebounce);
      stopPoll(); // also drops a pending input-debounced classify
      // Release the WebGL addon BEFORE the terminal: it also stops any pending
      // context-loss handler from rebuilding a renderer onto a dead terminal.
      webglHandle?.dispose();
      term?.dispose();
    };
    mounted = true;
  });

  // Re-fit when this session becomes visible (xterm can't measure while hidden).
  // Flush/reseed the stashed output first (R1) so refit measures final content.
  // A4: the classifyPane poll follows visibility — activation runs one classify
  // right away (after flush + refit) and restarts the 2s cadence; hiding pauses
  // it, and a tombstone (closed/done) stops it for good.
  $effect(() => {
    if (mounted && active && !closed && term && fit) {
      flushPending();
      queueMicrotask(() => { activateRefit(); startPoll(); });
    } else if (term) {
      stopPoll();
    }
  });

  // WebGL 上下文跟着可见性走（docs/bug/终端显示异常2 的真正修复）。
  //
  // 浏览器每页存活的 WebGL 上下文有硬上限（Chrome 实测 16，手机更低），超限后
  // 强制杀最老的。每个 tab 一个活上下文时，开几个窗口就会让老 tab 的渲染器被
  // 悄悄杀掉，表现为部分 tab 花屏/冻结，且只有关掉全部 tab 才恢复。
  //
  // 隐藏的终端不渲染，占着上下文毫无收益，所以切走即释放、切回再重建，存活数
  // 恒为 1，永远碰不到上限。
  //
  // closed 的终端是墓碑，不再渲染，也就不必占着上下文。
  //
  // mounted 是 $state，onMount 结尾才置 true，所以这个 effect 第一次真正生效时
  // installWebgl 已经跑完：初始就 active 的终端此时 resume 是 no-op（句柄本来
  // 就没 suspend），不会把刚建好的上下文拆掉重建。
  $effect(() => {
    const visible = active && !closed;
    if (!mounted || !webglHandle) return;
    if (visible) webglHandle.resume();
    else webglHandle.suspend();
  });

  // Live-apply font-size changes from settings: update xterm then re-fit + resize PTY.
  $effect(() => {
    const fs = fontSize;
    if (term && fit) {
      term.options.fontSize = fs;
      if (active) queueMicrotask(() => refit());
    }
  });
</script>

<div class="term" class:hidden={!active} class:closed bind:this={host}></div>

<style>
  .term {
    width: 100%;
    height: 100%;
    padding: 6px 8px;
  }
  .term :global(.xterm-viewport) {
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
  }
  /* Phase 5 req 1: allow native OS text selection on the terminal (mobile long-press).
     xterm DOM renderer uses real spans; overriding user-select lets the system
     selection handles appear. IME suppression is already handled by the helper
     textarea being readOnly + inputmode=none, so this does not bring up the keyboard.
     Known limits: multi-line selection may include trailing padding spaces; active
     output rebuilds the DOM and clears an in-progress selection. */
  .term :global(.xterm),
  .term :global(.xterm .xterm-screen),
  .term :global(.xterm .xterm-rows),
  .term :global(.xterm .xterm-rows *) {
    user-select: text;
    -webkit-user-select: text;
  }
  .hidden { display: none; }
  .closed { opacity: 0.6; }
</style>
