<script module lang="ts">
  // R1 (hidden terminals) output buffering lives in ../lib/pending-buffer.ts:
  // pure logic with no Svelte dependency, and a named export from a .svelte
  // file is invisible to `tsc --noEmit` (which only sees the ambient
  // `*.svelte` default export).
  import { PendingBuffer } from "../lib/term/pending-buffer";

  // xterm's theme takes literal colour strings, not CSS variables, so the
  // --term-* tokens are read off :root at runtime and handed over as an ITheme.
  // theme-tokens.css (generated from app/themes/*.ghostty) stays the single
  // source of truth: a new palette is a new file, not an edit here.
  //
  // 2026-08-05: this went from 4 tokens to 22. Before that the terminal used
  // xterm's own built-in ANSI 16, so `ls --color` and a git prompt looked
  // identical under every theme — "six themes" only ever reskinned the chrome
  // around a terminal that never changed. The ANSI slots now come from the
  // theme's own palette, which is also what makes a light theme's terminal
  // legible: it uses the foreground colours its author designed for that
  // background instead of xterm's dark-background defaults.
  //
  // Fallbacks are the default theme's (cream-dark) values, used only where
  // there is no CSS at all (bare test DOM / SSR).
  export interface TermTheme {
    background: string; foreground: string;
    cursor: string; cursorAccent: string;
    selectionBackground: string; selectionForeground: string;
    black: string; red: string; green: string; yellow: string;
    blue: string; magenta: string; cyan: string; white: string;
    brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string;
    brightBlue: string; brightMagenta: string; brightCyan: string; brightWhite: string;
  }

  /** `--term-ansi-<slot>` → ITheme key, in palette order 0..15. Slot names are
   *  the CSS side; the camelCase names are xterm's. */
  const ANSI_SLOTS: ReadonlyArray<[slot: string, key: keyof TermTheme, fallback: string]> = [
    ["black", "black", "#1f201f"],
    ["red", "red", "#ea928a"],
    ["green", "green", "#98c379"],
    ["yellow", "yellow", "#e5c07b"],
    ["blue", "blue", "#89a8ce"],
    ["magenta", "magenta", "#c891d9"],
    ["cyan", "cyan", "#75b5bc"],
    ["white", "white", "#ddd9cd"],
    ["bright-black", "brightBlack", "#8c887e"],
    ["bright-red", "brightRed", "#f2a29a"],
    ["bright-green", "brightGreen", "#a9d18e"],
    ["bright-yellow", "brightYellow", "#f0cf92"],
    ["bright-blue", "brightBlue", "#a6bde0"],
    ["bright-magenta", "brightMagenta", "#d9a9e8"],
    ["bright-cyan", "brightCyan", "#9bced3"],
    ["bright-white", "brightWhite", "#f8f7f2"],
  ];

  export function termTheme(): TermTheme {
    const read = (name: string, fallback: string): string => {
      if (typeof getComputedStyle !== "function") return fallback;
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    };
    const theme = {
      background: read("--term-bg", "#2d2e2d"),
      foreground: read("--term-text", "#ddd9cd"),
      // --term-accent and --term-cursor-text are `var()` aliases in the token
      // set; getComputedStyle resolves those, so what lands here is a literal.
      cursor: read("--term-accent", "#e6bf7a"),
      cursorAccent: read("--term-cursor-text", "#000000"),
      selectionBackground: read("--term-selection", "#736347"),
      selectionForeground: read("--term-sel-text", "#f8f7f2"),
    } as TermTheme;
    for (const [slot, key, fallback] of ANSI_SLOTS) {
      theme[key] = read(`--term-ansi-${slot}`, fallback);
    }
    return theme;
  }
</script>

<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { WebglAddon } from "@xterm/addon-webgl";
  import { installWebgl, type WebglHandle } from "../lib/term/webgl-renderer";
  import { snapshotAtlas, formatSnapshot } from "../lib/term/atlas-probe";
  import { snapshotScroll, formatScrollSnapshot } from "../lib/term/scroll-probe";
  import { hashLine, hashViewport, hashBufferTail, hashBufferTailBare } from "../lib/term/screen-probe";
  import { snapshotRender, subscribeRender } from "../lib/term/render-probe";
  import { kickRenderDebouncer } from "../lib/term/render-kick";
  import { snapshotWritePump, kickWritePump } from "../lib/term/write-pump";
  import { isMeasurable, isPlausible, rememberDims, shouldDeferShrink, SHRINK_HOLD_MS } from "../lib/term/fit-guard";
  import {
    buildReseedPayload, buildReseedReport, ReseedGate, concatReseedWrite, normalizeReseedRows,
    historyExpectBytes, reseedLines, seedRetryDelayMs, SEED_MAX_ATTEMPTS, type ReseedTrigger,
  } from "../lib/term/reseed";
  import { Connection } from "../lib/net/connection";
  import { decodeHistoryData } from "../lib/term/history-decode";
  import { DEFAULT_SETTINGS } from "../lib/settings";
  import type { TermHistoryResult } from "../lib/net/protocol";
  import { familyOf, termFontFamily, type FontId } from "../lib/font";
  import { t } from "svelte-i18n";
  import ProgressLine from "./ui/ProgressLine.svelte";

  let {
    conn,
    sessionId,
    active,
    streaming,
    closed = false,
    fontSize = 14,
    fontFamily = "maple-mono",
    historyLines = DEFAULT_SETTINGS.historyLines,
    onReady,
    onReseedReady,
  }: {
    conn: Connection;
    sessionId: string;
    active: boolean;
    streaming: boolean;
    closed?: boolean;
    fontSize?: number;
    fontFamily?: FontId;
    /** 重灌历史拉多少行。全量 2000 行在真机上要七秒，见 lib/term/history-decode.ts。 */
    historyLines?: number;
    onReady?: (sessionId: string, term: Terminal) => void;
    onReseedReady?: (sessionId: string, reseed: (t: ReseedTrigger) => void) => void;
  } = $props();

  let host: HTMLDivElement;
  // 首屏 seed（term.history）。历史行数越多越慢——设置项说明原文就是
  // "越少越快"，说明这条早被识别为慢路径。此前纯黑等待、零反馈（14 期需求 5）。
  let seeding = $state(true);
  // 首屏 seed 的失败态（2026-08-18）。此前失败只是把 seeding 关掉、什么都不说，
  // 用户面对一个永远空白的终端且没有任何线索。seedRetrying = 正在退避重试中；
  // seedFailed = 重试用尽，屏幕上留一个能点的重试入口。
  let seedRetrying = $state(false);
  let seedFailed = $state(false);
  // onMount 内赋值（同 refit 的生命周期）：模板里的重试按钮要能调到它。
  let retrySeed: () => void = () => {};
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
  // Delivery intent is independent of visibility. App may keep a hidden tab
  // streaming during the short switch-back grace window.
  let startStreaming: () => void = () => {};
  let stopStreaming: () => void = () => {};
  let streamingApplied = false;
  // Same lifecycle again: start/pause the classifyPane poll with visibility
  // (A4 — only the active, live session polls tmux).
  let startPoll: () => void = () => {};
  let stopPoll: () => void = () => {};
  // Same lifecycle as refit: forces a resize resend on activation even when this
  // device's xterm dims are unchanged (需求2 — re-assert THIS device's size on a
  // shared tmux session another device resized), then redraws to fill it.
  let activateRefit: () => void = () => {};
  // 【2026-08-24】resize 埋点的触发源。用户报告「终端在输出的时候我没有进行任何
  // 操作」却出现内容错乱，而 ResizeObserver 不需要用户操作就会触发（软键盘、
  // 滚动条出没、布局变化都算）。此前零 resize 埋点，「到底有没有 resize」在日志
  // 里答不了。只记数字：触发源 + 变化前后的 cols/rows。
  //
  // 必须是**组件作用域**：字号/字体两个 $effect 在这一层，够不到 onMount 内部的
  // 局部变量（写在里面会 ReferenceError，且发生在 queueMicrotask 里 —— 不是同步
  // 抛，测试只报 unhandled error，很容易被当成噪音放过）。
  let refitWhy = "init";
  // 切 tab 时拍一份滚动/尺寸快照（2026-08-09 取证）。onMount 里赋值，由下面
  // 跟随 active 的 $effect 调用，所以要活过 onMount 的闭包。
  let reportScroll: (why: string) => void = () => {};
  // 全链路采样（2026-08-22）。同样在 onMount 里赋值、由外部触发，见下方
  // sampleChain 处的长注释。默认空实现，未挂载时调用是安全的 no-op。
  let sampleNow: (why: string) => void = () => {};

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
    // 等当前字体就绪再让 xterm 测格子。传单个家族名——document.fonts.load()
    // 不吃回落链，喂整条链会静默什么都不加载，然后 xterm 用系统字体测出错误
    // 的格子宽度。
    try {
      await document.fonts.load(`${fontSize}px "${familyOf(fontFamily)}"`);
    } catch {
      // ignore
    }
    if (destroyed) return; // unmounted while the font loaded — set nothing up

    term = new Terminal({
      fontSize,
      // 字体跟随设置（2026-08-05 起）。xterm 只吃字面色值/字面字体名、不认 CSS
      // 变量——与下面 termTheme() 读 22 个颜色令牌同源。回落链（含 CJK 与 emoji）
      // 在 fonts.css 的 --font-mono 里定义一次，这里只是把计算值搬过来。
      //
      // 历史注记：改造前这里手抄了一条回落链，其中 CJK 部分是为「手机上中文显示
      // 成下划线」加的防御。那个 bug 的真因是 tmux 没跑在 UTF-8 locale 下（已由
      // agent/src/terminal.ts 的 `tmux -u` 修掉），这条链是双保险，现已随令牌继承。
      fontFamily: termFontFamily(),
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
      // 终端跟随主题明暗（2026-08-05 起）。xterm 只吃字面色值、不认 CSS 变量，
      // 所以在这里把 22 个 --term-* 读出来喂给它，ANSI 16 色也在内——换主题
      // 只需换 .ghostty 文件，不会再漏这里。
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
    // lib/webgl-renderer.ts。这里只提供一个钩子：怎么造一个新 addon。
    // 上下文丢失后**不**重灌历史（2026-08-08 订正）——xterm 的解析与渲染完全
    // 解耦，死掉的只是渲染器，字节照常进 core buffer，而 addon.dispose() 内部
    // 已经 setRenderer + _fullRefresh 从 buffer 重画过了。
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
    /**
     * agent 是否开着诊断埋点。**默认（拿不到答案时）视为关闭**。
     *
     * 用函数包一层而不是直接 `conn.hasFeature("diag")`：Connection 是通过 prop
     * 传进来的，测试替身与更早版本的连接对象上没有这个方法，直接调用会抛，而
     * 一个**诊断**判断把组件挂载搞挂，比没有诊断糟得多（本文件每个探针都包 try
     * 就是这个原则）。缺方法时返回 false，正好也是我们要的默认。
     */
    const diagOn = (): boolean => {
      try {
        return typeof conn.hasFeature === "function" && conn.hasFeature("diag");
      } catch { return false; }
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      // 【2026-08-28 渲染去抖器解卡】回前台必做，且**不受诊断开关门控**——这是
      // 功能修复不是取证。iOS 切后台会丢弃已排定的 rAF 回调，xterm 的
      // RenderDebouncer 从此拿不到那个「清除句柄」的机会，所有渲染请求在
      // 第一行 early-return，屏幕冻结而 buffer 照常更新（关掉重开才看到内容）。
      // 这里对**本终端实例**解卡；隐藏 tab 也安全（paused 下只是记账，见
      // render-kick.ts 文件头）。
      kickRenderDebouncer(term);
      // 顺带看一眼写泵（2026-08-28）：回前台时若已有滞留字节或解析器停在
      // 暂停/死刑态，重臂一次；泵健康时这是纯读 + no-op，成本可忽略。逻辑与
      // 上面的渲染解卡一致：这是功能修复，不受诊断开关门控。
      try {
        const wp = snapshotWritePump(term);
        if ((wp.stuck ?? 0) > 0 || wp.parsePaused === true || wp.parserState === 1) {
          kickWritePump(term);
        }
      } catch { /* 自愈绝不能影响任何东西 */ }
      if (!diagOn()) return;   // 诊断默认关闭（2026-08-23）
      try {
        const snap = snapshotAtlas(webglAddon, true);
        console.warn(formatSnapshot(sessionId, snap));
        void conn.rpc("diag.report", { tag: sessionId, kind: "atlas", ...snap }).catch(() => {});
      } catch { /* 诊断绝不能影响任何东西 */ }
      // 需求 3（12 期）：「回前台后终端渲染了最新内容却滚不上去」的取证。
      // 与图集快照分开 try/catch —— 其中一个探针因上游结构变动而失败时，
      // 另一个仍然要能发出去，否则一次结构变动会同时弄瞎两条线索。
      try {
        const s = snapshotScroll(term);
        console.warn(formatScrollSnapshot(sessionId, s));
        void conn.rpc("diag.report", { tag: sessionId, kind: "scroll", ...s }).catch(() => {});
      } catch { /* 同上 */ }
    };
    document.addEventListener("visibilitychange", onVisible);
    // 2026-08-09：同一份滚动快照，改成也能在**切 tab** 时拍。
    //
    // 真机报告的两个现象都发生在 tab 之间切换时：（1）终端只用左侧约 1/4 宽度
    // （列数塌陷）；（2）部分 tab 滑不动，且**宽度正常的 tab 也会滑不动**——
    // 后一句排除了「滚动问题只是列数问题的副作用」这个省事的解释，两条得分开查。
    //
    // 上面那个 onVisible 只监听 document 的 visibilitychange（切到别的 App /
    // 锁屏），tab 之间切换根本不触发它，所以现场一直没被拍到。这里把同一份探针
    // 挂到激活路径上，快照字段一个不改（cols 看塌陷、cellHeight/scrollHeight 看
    // 滚动塌陷），agent 侧白名单也无需改动。
    reportScroll = (why: string) => {
      if (!diagOn()) return;   // 同上
      try {
        const s = snapshotScroll(term);
        console.warn(formatScrollSnapshot(`${sessionId}/${why}`, s));
        void conn.rpc("diag.report", { tag: `${sessionId}/${why}`, kind: "scroll", ...s }).catch(() => {});
      } catch { /* 诊断绝不能影响任何东西 */ }
    };

    // ================= 全链路埋点（2026-08-22）=================
    //
    // 为什么加：「终端中间少几行、上下都在、重开就好」这个故障排查了两轮，
    // 连着七个假设被推翻（背压 / reseed 窗口 / scrollback 裁剪 / 图集失效 /
    // resize 抖动 / tmux 尺寸错位 / webgl 插件版本错位），每一轮都卡在同一处：
    // **日志答不上「故障那一刻数据在哪一层」**。上面那两个探针只在回前台/切
    // tab 时采样，而真机现场是「一直看着、什么都没操作」，那两条路径根本不触发。
    //
    // 这里补的三条心跳只在**该会话正在流式输出**时才发，静止时一条都不产生：
    //
    //   screen  tmux 真值 vs xterm 视口逐行对拍 → 判定数据丢了还是没画出来
    //   write   写入帧数/字节 vs buffer 行数增量 → 写进去了但没进 buffer
    //   render  渲染器是否还在动 + 图集状态       → 渲染器停摆
    //
    // 采样节流到 SAMPLE_MS：故障是「持续频繁发生」，不需要逐帧，日志也不能刷屏。
    const SAMPLE_MS = 15000;
    // scrollback 对拍的节流与深度。300 行覆盖「往上翻几屏」的范围，又远小于
    // tmux 的 history-limit(2000) 与 parse 的 2048 上限。
    const SCROLLBACK_EVERY = 4;
    const SCROLLBACK_LINES = 300;
    let scrollbackTick = 0;
    // 首次采样的基线必须是「挂载时刻」而不是 0：否则第一条日志的 sinceMs 会是
    // `Date.now() - 0` ——一个 Unix 时间戳（实测 1787410257448），而不是时间差。
    // 同理 renderFrames/wroteBytes 的首条差值也就成了「从纪元至今」的累计，读
    // 日志的人拿它除以时间会得出完全错的速率。上线第一批数据就是这么露馅的。
    const mountedAt = Date.now();
    // 每帧渲染计数。对照 write 心跳的 wroteBytes，两者背离即锁定渲染层。
    //
    // 【2026-08-23】这里**必须**走 render-probe 的 subscribeRender，不能用公开的
    // `term.onRender` —— 后者转发的是被 `_isNextRenderRedrawOnly` 门控的
    // onRenderedViewportChange，而普通流式输出正是 redraw-only，一次都不 fire。
    // 第一版埋点踩了这个坑，线上连着几十条 renderFrames=0，屏幕却明明在滚动。
    // 详见 render-probe.ts 里 subscribeRender 的注释。
    let renderCount = 0;
    let renderRows = 0;
    const unsubscribeRender = subscribeRender(term, (rows) => {
      renderCount++;
      renderRows += rows;
    });
    // 【2026-08-28 渲染冻结现场取证】把终端实例暴露给控制台（仅诊断开启时）。
    // 「buffer 对但屏不画」的故障需要交互式翻 xterm 内部状态（_isPaused /
    // synchronizedOutput / 去抖器句柄 / GL 上下文），心跳快照覆盖不了的部分
    // 靠它一次看全。键是 sessionId，组件卸载时移除。
    const exposeForDiag = () => {
      try {
        if (!diagOn()) return () => {};
        const w = window as unknown as { __pocketshellTerms?: Record<string, unknown> };
        const reg = (w.__pocketshellTerms ??= {});
        reg[sessionId] = term;
        return () => { try { delete reg[sessionId]; } catch { /* 尽力而为 */ } };
      } catch { return () => {}; }
    };
    const unexposeForDiag = exposeForDiag();
    let lastSampleAt = mountedAt;
    let lastSampleFrames = 0;
    let lastSampleBytes = 0;
    // -1 = 还没有基线。首条 write 心跳不该报 bufDelta —— 用 0 当基线的话，第一条
    // 恒等于整个 buffer 长度（实测 506），看起来像「这 15 秒里长了 506 行」。
    // 所有 delta 类字段都有这个坑，其余几个的基线 0 恰好是对的（帧数/字节数从
    // 0 开始累计），只有 bufLen 不是从 0 开始的。
    let lastSampleBufLen = -1;
    let lastSampleRenderFrames = 0;

    // ================= 自愈看门狗（2026-08-28）=================
    //
    // 为什么独立于 sampleChain 且**不受诊断门控**：心跳采样是取证（生产默认关），
    // 而下面两道卡死的自愈是功能。此前自愈只在 sampleChain 里顺带做，diag 一关
    // 前台冻结就永远不自愈 —— 真机 aippt（2026-08-28 上午）就是这个形态：字节
    // 到了 tmux、窗口开着、屏幕冻住、只能关掉重开。
    //
    // 两道卡死（完整根因分析见 write-pump.ts / render-kick.ts 文件头）：
    //   A) 渲染去抖器 rAF 句柄被系统丢弃 → refresh() 永远 early-return。
    //      签名：新字节在到 + 渲染帧为 0 + rendererSet/paused/domVisible 三闸健康。
    //   B) WriteBuffer 泵楔形卡死 → write() 只 push 不调度，字节永不解析。
    //      签名：新字节在到 + 滞留>0 + 解析位置 _bufferOffset 连续两轮不动。
    //      用 offset 而不是 stuck 当活性判据：泵死之后新写入会继续撑大
    //      _writeBuffer.length，stuck 反而在变；只有解析位置是真的冻结。
    //
    // 判定窗口：健康流式输出 5s 内渲染帧不可能为 0、单帧解析不可能跨过两轮
    // （10s）。静止会话在 bytesDelta<=0 就返回，一个数字比较，零成本。
    let healBytesBase = 0;
    let healFramesBase = 0;
    let pumpOffsetBase = -1;
    const healWatchdog = () => {
      if (!active || destroyed) return;
      const bytesDelta = probeBytes - healBytesBase;
      healBytesBase = probeBytes;
      const framesDelta = renderCount - healFramesBase;
      healFramesBase = renderCount;
      if (bytesDelta <= 0) { pumpOffsetBase = -1; return; }   // 这一轮没有新输出
      // A) 渲染去抖器卡死。kick 对没卡的终端是 no-op（读不到陈旧句柄就不动），
      //    所以每轮都问一次没有代价。
      if (framesDelta === 0) {
        try {
          const rsnap = snapshotRender(term);
          // 三闸读不到（undefined）不动手 —— 证据不全就别动手。
          if (rsnap.rendererSet === true && rsnap.paused === false && rsnap.domVisible === true) {
            const kick = kickRenderDebouncer(term);
            if (kick.kicked) {
              // 留了痕但不动 rpc：诊断关着时 console 是唯一的留痕处。
              console.warn(`[pocketshell] render-kick(watchdog) ${sessionId}`);
              if (diagOn()) {
                try {
                  const buf = term.buffer.active;
                  void conn.rpc("diag.report", {
                    tag: sessionId, kind: "render-kick", phase: "watchdog",
                    why: "watchdog", kicked: true, unreadable: false,
                    ydisp: buf.viewportY, baseY: buf.baseY, bufferLength: buf.length,
                    wroteBytes: bytesDelta,
                  }).catch(() => {});
                } catch { /* 诊断绝不能影响任何东西 */ }
              }
            }
          }
        } catch { /* 自愈绝不能影响任何东西 */ }
      }
      // B) 写泵卡死。两轮确认：第一轮记下位置，第二轮位置没动才重臂。
      try {
        const wp = snapshotWritePump(term);
        if (wp.stuck === undefined || wp.offset === undefined) { pumpOffsetBase = -1; return; }
        if (wp.stuck === 0 || wp.offset !== pumpOffsetBase) { pumpOffsetBase = wp.offset; return; }
        pumpOffsetBase = -1;
        const kick = kickWritePump(term);
        console.warn(`[pocketshell] pump-kick ${sessionId} stuck=${wp.stuck} pending=${wp.pending} kicked=${kick.kicked} parserReset=${kick.parserReset}`);
        if (diagOn()) {
          void conn.rpc("diag.report", {
            tag: sessionId, kind: "pump-kick", phase: "watchdog",
            wroteBytes: bytesDelta,
            wbPending: wp.pending, wbStuck: wp.stuck, wbOffset: wp.offset,
            parserState: wp.parserState, parsePaused: wp.parsePaused,
            kicked: kick.kicked, unreadable: kick.unreadable ?? false,
            parserReset: kick.parserReset ?? false,
          }).catch(() => {});
        }
      } catch { /* 同上 */ }
    };

    /**
     * 一轮全链路采样。**永远不抛**：任何一条探针因上游结构变动而失败，都不能
     * 影响另外两条，更不能影响终端本身（诊断把会话搞挂比没有诊断更糟）。
     *
     * `why` 进 phase 字段，用来区分是心跳打的还是别的路径触发的。
     */
    const sampleChain = (why: string) => {
      const now = Date.now();
      const dt = now - lastSampleAt;
      lastSampleAt = now;

      // 1) 写入量 vs buffer 增量。两者长期背离 = 字节写进 xterm 却没落进 buffer。
      // wroteBytes 增量提到 try 外面：第 2 步的解卡判定要用它对照 renderFrames。
      const wroteBytesDelta = probeBytes - lastSampleBytes;
      try {
        const bufLen = term.buffer.active.length;
        void conn.rpc("diag.report", {
          tag: sessionId, kind: "write", phase: why,
          wroteFrames: probeFrames - lastSampleFrames,
          wroteBytes: wroteBytesDelta,
          // 无基线时报 -1（"读不到"），与 0（"真的没长"）区分开——这个区别在
          // diag-report.ts 里是刻意保住的，别在这里归一。
          bufDelta: lastSampleBufLen < 0 ? -1 : bufLen - lastSampleBufLen,
          sinceMs: dt,
        }).catch(() => {});
        lastSampleFrames = probeFrames;
        lastSampleBytes = probeBytes;
        lastSampleBufLen = bufLen;
      } catch { /* 诊断绝不能影响任何东西 */ }

      // 2) 渲染器心跳 + 图集。renderFrames=0 而 wroteBytes>0 ⇒ 字节到了、渲染器
      // 没动，buffer 再对也画不出来。dirtyRows 是这段时间里被重画的行数累计
      // （xterm 的 onRender 给出每次重画的行区间），它直接回答「那几行到底
      // 有没有被画过」——这是七轮排查里始终缺的那个数。
      try {
        const snap = snapshotAtlas(webglAddon, true);
        // 渲染服务状态（2026-08-22 第二批）：renderFrames=0 之后必须能分清
        // 「被暂停了」还是「渲染器指针空了」——两者修法完全不同，而 atlas 探针的
        // hasRenderer 查的是 WebGL addon 对象，答不了这个问题。见 render-probe.ts。
        const rsnap = snapshotRender(term);
        const renderFramesDelta = renderCount - lastSampleRenderFrames;
        // 【2026-08-28 渲染去抖器解卡】四字段同时成立 = rAF 句柄被后台丢弃后
        // RenderDebouncer 永久卡死（字节在写、buffer 在长、两道闸都健康、
        // 就是零渲染帧）。这是前两道防线（回前台/切 tab 各踢一次）之后的兜底：
        // 别的路径把卡死造出来，15 秒内也能自愈，且日志里留下 render-kick 留痕。
        // paused/domVisible 读不到（undefined）时不踢——证据不全就别动手。
        if (
          renderFramesDelta === 0 && wroteBytesDelta > 0 &&
          rsnap.rendererSet === true && rsnap.paused === false && rsnap.domVisible === true
        ) {
          const kick = kickRenderDebouncer(term);
          // 带上滚动状态：滚离底部（ydisp<baseY）时底行重绘被视口门拦掉是
          // xterm 的刻意行为（见 onInput 里的回底部注释），这条留痕能直接
          // 区分「滚上去了」与「真卡死」。
          const buf = term.buffer.active;
          void conn.rpc("diag.report", {
            tag: sessionId, kind: "render-kick", phase: why,
            why: "heartbeat", kicked: kick.kicked, unreadable: kick.unreadable ?? false,
            ydisp: buf.viewportY, baseY: buf.baseY, bufferLength: buf.length,
            wroteBytes: wroteBytesDelta, sinceMs: dt,
          }).catch(() => {});
        }
        void conn.rpc("diag.report", {
          tag: sessionId, kind: "render", phase: why,
          renderFrames: renderFramesDelta,
          dirtyRows: renderRows,
          sinceMs: dt,
          ...snap,
          ...rsnap,
        }).catch(() => {});
        lastSampleRenderFrames = renderCount;
        renderRows = 0;
      } catch { /* 同上 */ }

      // 3) 屏幕对拍。放最后：它要发一轮 rpc 且 agent 侧要 spawn 一次 tmux，
      // 前两条更便宜、更不该被它拖累。alt buffer 里 capture-pane 拿到的是
      // 另一块屏，比对没有意义，直接跳过。
      try {
        if (currentBuffer === "normal") {
          const hashes = hashViewport(term);
          // 空视口不比：首屏 seed 还在路上时（激活的那一刻 bufferLength 恰好等于
          // rows、全是空行），对拍会把 tmux 的每一非空行都报成缺失。上线实测就
          // 拍到过这样一条「27 行缺 19 行」——19 正是 tmux 侧的非空行数，而 xterm
          // 侧非空行为 0。那不是故障，是拍早了。
          //
          // 判据放在客户端而不是 agent：只有这里知道「我这一屏还没内容」，agent
          // 拿到的是一串哈希，分不出「空屏」与「内容恰好全变了」。
          const EMPTY = hashLine("");
          if (hashes.some((h) => h !== EMPTY)) {
            void conn.rpc("diag.screen", { session: sessionId, why, hashes }).catch(() => {});
          }
          // scrollback 对拍（2026-08-24）。视口对拍只看屏上 27 行，而「往上翻才
          // 发现少了一段」的丢失全在 scrollback 里 —— 两边看的都不是出事的地方，
          // 于是一路报 missingLines=0。今天已经因为这个盲区两次把「没有证据」
          // 当成「没有问题」。
          //
          // 节流到 SCROLLBACK_EVERY 轮一次：它要传几百个哈希、agent 侧再 spawn
          // 一次 capture-pane，比视口那次贵得多，不该每轮都做。
          scrollbackTick++;
          if (scrollbackTick % SCROLLBACK_EVERY === 0) {
            const tail = hashBufferTail(term, SCROLLBACK_LINES);
            // 历史还没攒够就不比：buffer 里只有一屏时 tail 是空的，比出来
            // 「tmux 有 N 行、我一行都没有」——又是一条「拍早了」的假故障。
            if (tail.length >= 20 && tail.some((h) => h !== EMPTY)) {
              // 同一批行送两套哈希：hashes 保留行首缩进，hashesBare 两端空白全去。
              // 只有 hashes 那套报缺、bare 那套不缺，说明字还在、差的是空白。
              void conn.rpc("diag.screen", {
                session: sessionId, why, scope: "scrollback",
                lines: SCROLLBACK_LINES, hashes: tail,
                hashesBare: hashBufferTailBare(term, SCROLLBACK_LINES),
              }).catch(() => {});
            }
          }
        }
      } catch { /* 同上 */ }
    };

    /** 供外部（心跳/手动触发）调用；节流由调用方或这里的时间闸控制。 */
    sampleNow = (why: string) => {
      if (!active) return;            // 隐藏的终端不参与：它本来就不渲染
      // agent 没开诊断就一次都不采：这套埋点是排查工具，默认关闭（见 agent 的
      // diag-report.ts）。少了这道判断，关掉诊断也只是「服务端把结果丢掉」，
      // 手机这边照样每 15s 三条 rpc + 一次全视口哈希。
      if (!diagOn()) return;
      sampleChain(why);
    };

    // 心跳：只在「距上次采样超过 SAMPLE_MS **且这期间真的有新字节**」时采样。
    // 后一个条件是关键——会话静止时一条日志都不该产生，否则十几个会话挂一夜
    // 就把日志刷成噪音，真出故障时反而翻不到。
    const heartbeat = setInterval(() => {
      if (!active || destroyed) return;
      healWatchdog();   // 自愈先行：不受诊断门控（2026-08-28）
      if (!diagOn()) return;   // 同 sampleNow：采样与上报默认关闭
      if (probeBytes === lastSampleBytes) return;   // 这一轮没有新输出
      if (Date.now() - lastSampleAt < SAMPLE_MS) return;
      sampleChain("stream");
    }, 5000);
    (heartbeat as unknown as { unref?: () => void })?.unref?.();
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
    // 这里**不**调 fit.fit()（2026-08-09）。它内部直接 term.resize(proposeDimensions())，
    // 绕过下面 refit() 的 isMeasurable / isPlausible 两道门 —— 而新建 tab 是**隐藏挂载**
    // 的（display:none），此刻量出来正是 9~12 列的塌陷值。塌陷的列数会被 conn.resize
    // 上报给 tmux，Claude Code 按错误宽度把硬换行打进历史，**不可逆**（详见
    // lib/term/fit-guard.ts）。真机症状：新开的 tab 只用左侧约 1/4 宽度。
    //
    // 首屏尺寸由下面这些路径负责，它们都走 refit() 的守卫：`if (active) refit()`
    // （本函数末尾，此时 refit 已被赋值）、变为可测量时 ResizeObserver 的那一跳、
    // 以及切成活动 tab 时的 activateRefit()。这里不能补调 refit —— 它此刻还是
    // 顶部那个 no-op stub（真正的实现在下面才赋值），调了等于没调。

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
    // 行数收缩迟滞的状态（2026-08-25，「中间丢行」的根因，详见 fit-guard.ts 末节）。
    // 一次变矮先不应用，压 SHRINK_HOLD_MS 再复量；`confirmingShrink` 标记这一次
    // 复量必须放行，否则持续偏小的尺寸会被无限期推迟。
    let shrinkTimer: ReturnType<typeof setTimeout> | undefined;
    let confirmingShrink = false;
    refit = () => {
      // 确认标志必须在**任何早退之前**取走并清零（2026-08-25 线上逮到的 bug）：
      // 下面两道守卫（不可测量 / 尺寸不可信）会 return，若清零写在它们之后，一次
      // 早退的确认复量就把 `true` 永久留在那里，此后**任意一次** refit 都被当成
      // 「确认通过」而直接放行收缩 —— 迟滞被整个绕过，且会一直粘着。
      // 线上现象：03:19:05.591 的 27→26 就是这么漏出去的（100ms 后又弹回 27）。
      const confirming = confirmingShrink;
      confirmingShrink = false;
      // 量不到就不量（12 期真机 bug 的根因防线，详见 lib/term/fit-guard.ts）。
      //
      // `display:none` 的元素不参与布局，`getComputedStyle(el).width` 会把**声明值**
      // 原样吐回来——`.term` 写的是 `width:100%`，拿到的就是字符串 "100%"。FitAddon
      // 对它 `parseInt` 得到 100，当成 100 像素，于是 cols 塌成 9~12（真机实测 12）。
      // FitAddon 自己的 `Math.max(0, ...)` 挡不住：坏值是个**看着很合理的正数**。
      //
      // 后果不可逆：Claude Code 读 winsize 后自己算折行、把 \n 打进输出流，tmux 只能
      // reflow 自己折的软折行，还不回来（实测 `capture-pane -J` 也拼不回）。所以宁可
      // 保持旧尺寸，也不能拿猜出来的尺寸去 resize。
      //
      // 等待没有用：等 rAF / 2000ms / fonts.ready 结果都一样，唯一能改变它的事件是
      // 「元素被显示」——下面的 ResizeObserver 正是在等这个事件。
      if (!isMeasurable(host)) return;
      const d = dims();
      // 可测量了也仍要验一次：字体未就绪等边缘情况同样可能算出离谱的格子数。
      if (!isPlausible(d)) return;
      // 只记可信值：兜底一旦被塌陷值污染，一次性故障就变成永久故障。
      rememberDims(d);
      // 变高立刻应用，变矮先压住 —— 只有变矮会把行推进 scrollback 并永久定格。
      if (shrinkTimer) { clearTimeout(shrinkTimer); shrinkTimer = undefined; }
      let rows = d.rows;
      if (shouldDeferShrink({ cols: term.cols, rows: term.rows }, d, confirming)) {
        rows = term.rows; // 本次维持原高度：不缩、也不通知 PTY
        const why = refitWhy;
        shrinkTimer = setTimeout(() => {
          shrinkTimer = undefined;
          confirmingShrink = true;
          refitWhy = why;
          refit(); // 到点重新量：仍然偏小才是真的变矮，那时才应用
        }, SHRINK_HOLD_MS);
      }
      if (term.cols !== d.cols || term.rows !== rows) term.resize(d.cols, rows);
      // proposeDimensions can over-count by ~1 col on narrow mobile viewports
      // (padding/scrollbar rounding), clipping the rightmost cells off-screen.
      // Shrink a column at a time until the rendered screen fits the host width.
      const screen = host.querySelector(".xterm-screen") as HTMLElement | null;
      let guard = 4;
      while (screen && screen.scrollWidth > host.clientWidth && term.cols > 20 && guard-- > 0) {
        term.resize(term.cols - 1, term.rows);
      }
      const changed = term.cols !== lastSentCols || term.rows !== lastSentRows;
      if (changed) {
        const fromCols = lastSentCols;
        const fromRows = lastSentRows;
        lastSentCols = term.cols;
        lastSentRows = term.rows;
        conn.resize(sessionId, term.cols, term.rows);
        // 尺寸真的变了才记：不变的 refit 每次滚动都可能发生，记了就是噪音。
        if (diagOn()) {
          void conn.rpc("diag.report", {
            tag: sessionId, kind: "resize", why: refitWhy,
            fromCols, fromRows, toCols: term.cols, toRows: term.rows, sentToPty: 1,
          }).catch(() => {});
        }
      }
    };

    // R1: while hidden, stash raw bytes instead of writing to xterm (parse +
    // render is the expensive part); activation flushes them in one write.
    // Tombstoned sessions get no live stream anymore — drop their frames.
    // 埋点计数器：实时流到达的帧数与字节数（单调递增，只做差值用）。
    let probeFrames = 0;
    let probeBytes = 0;
    const pendingOut = new PendingBuffer();
    // 优先级 4（2026-08-18）：reloadHistory 的 t0..t1 窗口旁录。
    //
    // 重灌期间到达的实时字节会被 t1 快照的 RIS 抹掉：快照里没有（拍摄时还没产生），
    // RIS 又清屏 → **永久消失**。丢的是时间中段，所以症状是「Claude Code 大量输出时
    // 中间几行不见了」而不是「最新几行不见了」。真机 rtt 中位 1931ms、最高 9283ms，
    // 那是很宽的一个洞。
    //
    // 丢失的字节从来没离开过客户端，所以不必向服务端再要一次（补发 attach(h.seq)
    // 那条路已被证伪：connection.ts 的 `if (subscribed || …) return` 在 seen 覆盖
    // 之后 → 帧发不出去但 seen 已回退，且会形成 resync→重灌→attach→gap→resync
    // 自激环）。窗口开着时旁录一份，快照到达时拼在后面重写即可。
    //
    // 复用 PendingBuffer 是为了白拿它的 2MB 上限与 dirty 语义：窗口内涌进超过上限
    // 的字节时它自己丢弃并置 dirty，我们据此放弃回灌（宁可丢，也不能让一个卡住的
    // 重灌把内存吃穿）。
    let windowBuf: PendingBuffer | null = null;
    const unsubscribeOutput = conn.onOutput((f) => {
      if (f.sessionId !== sessionId) return;
      if (!streaming) return;
      probeFrames++;
      probeBytes += f.data.byteLength;
      if (active) { term.write(f.data); windowBuf?.push(f.data, f.seq); return; }
      if (closed) return;
      // seq 要跟着进暂存：隐藏期间可能发生 resync 重灌，快照一落地这批字节里
      // seq ≤ 快照号的部分就作废了（见 reloadHistory 里的 dropUpTo）。不带 seq
      // 的话分不出哪些作废，激活时会把它们整份压在快照之后重放一遍。
      pendingOut.push(f.data, f.seq);
    });

    // Seed tmux history into the shell's normal buffer, replacing what xterm
    // holds. Called when the pane (re)enters shell mode, when the hidden stash
    // overflowed, and when the server says bytes were dropped (resync).
    // 重灌历史：清空后按当前宽度重灌整份 tmux 快照。
    //
    // 【2026-08-08 重写】此前用 term.reset() 清屏，那是错的 —— xterm 的 write()
    // 是异步入队的，而 reset() 同步且不清那个队列，于是 reset 之前排队的实时
    // 字节会在 reset **之后**被解析，与快照熔成一行。真机症状是 `p8rmissions`
    // （应为 bypass permissions）与同一个 UI 框多世代堆叠。
    //
    // 历史注记：更早一版用的是 clear()，当时实测「clear() 会熔行、reset() 不会」
    // 于是换成了 reset()。那个实测是**误诊** —— 看到的熔行正是本 bug，换 reset()
    // 只是把发作概率压低了（它比 clear 多复位了一些状态），竞态一直都在，所以
    // 故障后来又回来了。真正的解法是 xterm 上游注释里写的那条：用流内 RIS。
    // 载荷拼装与代际闸门在 lib/term/reseed.ts，那里有完整的实测记录。
    const reseedGate = new ReseedGate();
    let recoveryGeneration = 0;
    let needsReseed = false;

    /**
     * 上报一次重灌的诊断。
     *
     * 【2026-08-18 两处修正】
     * 1) `bufferLenAfter` 由调用方在 `term.write(payload, cb)` 的**回调里**取。
     *    xterm 的 write 是异步入队的（WriteBuffer 按 12ms 时间片解析），在 write
     *    的同步下一行读 buffer.active.length 量到的是写入**之前**的状态。真机日志
     *    「45% 的 reseed bufferLenBefore == bufferLenAfter」因此是测量假象而非
     *    「快照白拉」：那 37 个样本 37/37 的 before 都等于 24（=rows），而
     *    snapshotBytes 中位 20939 —— 数据明明拿到了。
     * 2) 失败分支也要上报。此前 diag.report 在 `await conn.rpc()` 之后、同一个 try
     *    内，外层是空 catch，于是 history 一超时就零日志 —— 82 条样本全是幸存者，
     *    越糟的链路越不出现在统计里。
     */
    const reportReseed = (
      trigger: ReseedTrigger,
      startedAt: number, framesAtStart: number, bytesAtStart: number,
      lenBefore: number, lenAfter: number,
      snapshotBytes: number, discarded: boolean, error?: string,
    ) => {
      if (!diagOn()) return;   // 诊断默认关闭（2026-08-23）
      try {
        void conn.rpc("diag.report", {
          tag: sessionId,
          ...buildReseedReport({
            trigger,
            rttMs: Date.now() - startedAt,
            discarded,
            snapshotBytes,
            framesDuringAwait: probeFrames - framesAtStart,
            bytesDuringAwait: probeBytes - bytesAtStart,
            bufferLenBefore: lenBefore,
            bufferLenAfter: lenAfter,
            error,
          }),
        }).catch(() => {});
      } catch { /* 探针永不影响终端本身 */ }
    };

    /** rpc 失败原因的短标签。只取 code/message，绝不带响应体（日志会被贴进公开 issue）。 */
    const errLabel = (e: unknown): string => {
      const x = e as { code?: string; message?: string } | null;
      return String(x?.code ?? x?.message ?? "error").slice(0, 120);
    };

    type HistorySnapshot = { text: string; seq: number };
    const loadHistorySnapshot = async (lines: number): Promise<HistorySnapshot> => {
      const h = (await conn.rpc(
        "term.history", { session: sessionId, lines },
        { expectBytes: historyExpectBytes(lines) },
      )) as TermHistoryResult;
      return {
        text: h?.data ? await decodeHistoryData(h.data, h.enc) : "",
        seq: typeof h?.seq === "number" ? h.seq : 0,
      };
    };

    const commitSnapshot = (
      snapshot: HistorySnapshot,
      live: Uint8Array | null,
      onCommitted: () => void,
    ) => {
      term.write(concatReseedWrite(buildReseedPayload(snapshot.text), live), onCommitted);
    };

    const reloadHistory = async (trigger: ReseedTrigger = "alt-normal") => {
      if (currentBuffer !== "normal") return;
      const gen = reseedGate.begin();
      // 埋点：量 await 窗口有多宽、期间涌进来多少实时字节。旧实现下那些字节
      // 正是会被 reset() 抹掉的内容，所以这两个数直接对应故障严重程度。
      const startedAt = Date.now();
      const framesAtStart = probeFrames;
      const bytesAtStart = probeBytes;
      const lenBefore = term.buffer.active.length;
      // t0：开窗旁录。上一代若还开着窗（乱序返回），它的字节归新一代 —— 代际闸门
      // 会把旧快照整份丢弃，旧窗口跟着旧快照走就等于白丢，跟着新快照走才不丢。
      const win = new PendingBuffer();
      windowBuf = win;
      try {
        // 【2026-08-23】拉的行数不能少于 buffer 里已有的：RIS 清的是**整个**
        // buffer（含 scrollback），只回写 historyLines 行的话，差额就是被抹掉的
        // 历史。真机实测单次净损失 585 行。见 reseed.ts 的 reseedLines。
        const wantLines = reseedLines(historyLines, lenBefore);
        const h = (await conn.rpc(
          "term.history", { session: sessionId, lines: wantLines },
          // 让死线把响应体算进去。不传的话 N 个并发重灌与 1 个拿到完全相同的
          // 10s 死线，8 tab 同时重进时后面的 lane 必然假超时（见 reseed.ts）。
          { expectBytes: historyExpectBytes(wantLines) },
        )) as TermHistoryResult;
        // 期间有更新的重灌发起 —— 这份快照已经过时，整份丢弃。
        const stale = reseedGate.isStale(gen);
        const data = stale ? "" : await decodeHistoryData(h?.data ?? "", h?.enc);
        // 过期的一代不许动窗口：它的旁录已经归给新一代了（windowBuf 早被覆盖）。
        // dirty 表示窗口内涌进的字节超过 2MB 上限、已被 PendingBuffer 丢弃，
        // 此时拿到的是**残缺**的字节流，回灌反而会写出错乱的屏幕 —— 宁可只写快照。
        // 【2026-08-23】按快照 seq 过滤旁录，否则重连出现 gap 时会写出长串重复：
        // 服务端先发 resync 再补发最新 32KB，而 onResync 是同步发起重灌 ⇒ 那 32KB
        // 落进了旁录；但它们的 seq ≤ 快照 seq，**已经在快照里**。详见
        // PendingBuffer.takeAfter 的注释。h.seq 缺席时退化为不过滤（老 agent）。
        const snapshotSeq = typeof h?.seq === "number" ? h.seq : 0;
        const windowBytes = stale || win.dirty ? null : win.takeAfter(snapshotSeq);
        if (!stale) { windowBuf = null; }
        // await 期间组件可能已卸载，或 pane 已切进 alt buffer（那里 capture-pane
        // 拿到的东西没有意义）。两者都不该再写。
        //
        // RIS、快照、窗口旁录必须拼进**同一次** write：拆成两次虽然队列里也有序，
        // 但中间会插进实时帧，修复即失效。lib/term/reseed.ts 有断言守着这一点。
        if (!stale && !destroyed && currentBuffer === "normal") {
          // 隐藏期攒下的积压里，seq ≤ 快照号的那部分已经体现在这份快照里了。
          // 不在这里丢掉的话，用户切回来时 flushPending 会把它们整份重放到一份
          // 已是终态的 buffer 上 —— 那正是 2026-08-27 teachppt「AI 最后一次的
          // 输出不见了」的成因（真机 104,599 字节）。详见 PendingBuffer.dropUpTo。
          pendingOut.dropUpTo(snapshotSeq);
          term.write(concatReseedWrite(buildReseedPayload(data), windowBytes), () => {
            // 回调触发 = 这批字节已解析完，此刻的行数才是真的（见 reportReseed）。
            reportReseed(trigger, startedAt, framesAtStart, bytesAtStart, lenBefore,
              term.buffer.active.length, data.length, stale);
          });
        } else {
          reportReseed(trigger, startedAt, framesAtStart, bytesAtStart, lenBefore,
            term.buffer.active.length, data.length, stale);
        }
      } catch (e) {
        // 失败也要留下窗口的字节：它们已经写进 xterm 了，没有 RIS 来抹，不必回灌。
        if (windowBuf === win) windowBuf = null;
        reportReseed(trigger, startedAt, framesAtStart, bytesAtStart, lenBefore,
          term.buffer.active.length, 0, false, errLabel(e));
      }
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
    //
    // 【2026-08-18 优先级 1b】此前的 catch 只做一次 attach(0)、finally 里把
    // seeding 关掉，于是失败=**永久吸收态**：无重试、无提示、无埋点。而此后三条
    // 重灌路径在该场景下全部不触发（alt-normal 因 appliedMode 初值就是 "normal"
    // 而永不发生；stash-dirty 在 87 条生产日志里 0 次；resync 要服务端主动发），
    // 结果就是用户报告的「8 个 tab 重进全部空白，关掉重开才好」——「重开才好」
    // 恰恰因为只有重新挂载才能再走一次本函数。
    //
    // 现在：退避重试 SEED_MAX_ATTEMPTS 次，全用尽后**保留可见且可点的重试入口**，
    // 而不是让提示静默消失。
    let seedTimer: ReturnType<typeof setTimeout> | undefined;
    let hasStreamed = false;
    const cancelSeedRetry = () => {
      if (!seedTimer) return;
      clearTimeout(seedTimer);
      seedTimer = undefined;
    };
    const seedFromHistory = async (attempt = 0) => {
      const gen = recoveryGeneration;
      // 重试成功后这三个必须一起归位：只清 seeding 的话，内容出来了却一直盖着
      // 一层「正在重试」的半透明提示。
      seedFailed = false;
      seedRetrying = false;
      seeding = true;
      const startedAt = Date.now();
      const framesAtStart = probeFrames;
      const bytesAtStart = probeBytes;
      const lenBefore = term.buffer.active.length;
      try {
        const snapshot = await loadHistorySnapshot(historyLines);
        if (destroyed || !streaming || gen !== recoveryGeneration) return;
        let text = "";
        if (snapshot.text) {
          // 保持首屏语义不变：**不带 RIS**（终端此刻本就是空的，见上方注释），
          // 只做行规范化。这里刻意不走 buildReseedPayload —— 那是重灌路径的
          // 载荷，会多一个 RIS 前缀；两者共用 normalizeReseedRows，所以「结尾
          // 那个换行要去掉」（光标停在快照最后一行）对首屏同样成立。
          text = normalizeReseedRows(snapshot.text);
          term.write(text, () => {
            reportReseed("seed", startedAt, framesAtStart, bytesAtStart, lenBefore,
              term.buffer.active.length, text.length, false);
          });
        } else {
          reportReseed("seed", startedAt, framesAtStart, bytesAtStart, lenBefore,
            term.buffer.active.length, 0, false);
        }
        conn.attach(sessionId, snapshot.seq, { seed: true });
        seeding = false;
        needsReseed = false;
      } catch (e) {
        if (destroyed || !streaming || gen !== recoveryGeneration) return;
        // 首屏路径此前**零埋点**，而它才是「重进应用」的主路径 —— 首屏空白在日志里
        // 一个直接证据都没有。这条补上后才谈得上验证修复。
        reportReseed("seed", startedAt, framesAtStart, bytesAtStart, lenBefore,
          term.buffer.active.length, 0, false, errLabel(e));
        // 实时流先接上（不带 seed，走 replay 兜底），这样即使快照始终拉不到，
        // 新产生的输出仍然看得见 —— 与旧行为一致，只是不再到此为止。
        conn.attach(sessionId);
        if (attempt + 1 < SEED_MAX_ATTEMPTS) {
          seeding = false;
          seedRetrying = true;
          seedTimer = setTimeout(() => { seedTimer = undefined; void seedFromHistory(attempt + 1); }, seedRetryDelayMs(attempt));
          return;
        }
        // 重试用尽：把失败摆在屏幕上，并留一个能点的入口。静默消失才是最坏的
        // 结果 —— 用户面对的是一个永远空白且没有任何线索的终端。
        seeding = false;
        seedRetrying = false;
        seedFailed = true;
      }
    };

    const resumeFromHistory = async () => {
      const gen = ++recoveryGeneration;
      const activeAtStart = active;
      const startedAt = Date.now();
      const framesAtStart = probeFrames;
      const bytesAtStart = probeBytes;
      const lenBefore = term.buffer.active.length;
      seedFailed = false;
      seedRetrying = false;
      seeding = true;
      try {
        const snapshot = await loadHistorySnapshot(historyLines);
        if (destroyed || !streaming || gen !== recoveryGeneration || active !== activeAtStart) return;
        commitSnapshot(snapshot, null, () => {
          if (destroyed || !streaming || gen !== recoveryGeneration || active !== activeAtStart) return;
          reportReseed("seed", startedAt, framesAtStart, bytesAtStart, lenBefore,
            term.buffer.active.length, snapshot.text.length, false);
          needsReseed = false;
          seeding = false;
          conn.attach(sessionId, snapshot.seq, { seed: true });
        });
      } catch (e) {
        if (destroyed || !streaming || gen !== recoveryGeneration) return;
        reportReseed("seed", startedAt, framesAtStart, bytesAtStart, lenBefore,
          term.buffer.active.length, 0, false, errLabel(e));
        seeding = false;
        seedRetrying = false;
        seedFailed = true;
        needsReseed = true;
      }
    };

    /** 手动重试。从第 0 次重新计数；离线恢复失败则保留旧屏并重试恢复。 */
    retrySeed = () => {
      if (destroyed || !streaming) return;
      if (needsReseed && hasStreamed) void resumeFromHistory();
      else void seedFromHistory(0);
    };

    stopStreaming = () => {
      recoveryGeneration++;
      conn.detach(sessionId);
      pendingOut.take();
      pendingOut.clearDirty();
      cancelSeedRetry();
      needsReseed = true;
      seeding = false;
      seedRetrying = false;
    };

    // Activation path (R1). A dirty stash means the byte stream is incomplete,
    // so replaying it would corrupt the screen: reseed from tmux instead — or,
    // in the alternate buffer where capture-pane is useless, ask the pane app
    // to repaint. Otherwise write the stashed bytes in one go.
    flushPending = () => {
      if (pendingOut.dirty) {
        pendingOut.clearDirty();
        if (currentBuffer === "normal") void reloadHistory("stash-dirty");
        else void conn.rpc("term.redraw", { session: sessionId }).catch(() => {});
        return;
      }
      const data = pendingOut.take();
      if (data) {
        term.write(data);
        // 与 onOutput 的 active 分支对称：重灌在路上时切走又切回，这批字节同样是
        // 「写进了 xterm 却不在快照里」的内容，t1 的 RIS 照样抹。旁录路径只有
        // 这两个入口，两个都要挂上。
        windowBuf?.push(data);
      }
    };

    activateRefit = () => {
      // 需求2: bypass the R3 suppression guard so conn.resize goes out on every
      // activation. If the shared tmux window already matches this device the
      // agent no-ops (SIGWINCH only fires on a real size change); if another
      // device shrank it, this pulls it back and tmux repaints via the live
      // stream. No explicit reseed here — that would clear+redraw on every tab
      // switch (and double-reseed the dirty-stash case that flushPending handles).
      // 激活必发一次 resize（见上），所以它在日志里天然高频 —— 单独标记，
      // 免得把「没人操作却 resize」这个真正要找的信号淹掉。
      refitWhy = "activate";
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
        // 判定要带上 xterm 的**真实**缓冲区，不能只比 appliedMode。
        //
        // appliedMode 只是「我们以为」的状态。两者一旦脱钩（xterm 留在 alt 屏而
        // appliedMode 写着 normal），tmux 报 normal、我们记的也是 normal，边沿判定
        // 认为「一致」→ 永久不进修复分支。真机实测到的正是这个死锁：
        //     tmux alternate_on=0，探针拍到 xterm bufferType=alternate
        //     len=26(=rows) baseY=0 scrollH==clientH  → 上方零行可滚
        // 现象是「内容照常刷新，但怎么都滚不上去，只有关掉 tab 重开才好」——
        // alt 屏本来就没有 scrollback，几千行历史都在 normal 缓冲区里没显示。
        //
        // currentBuffer 由 onBufferChange 忠实跟踪，修复所需的信息本来就在手上，
        // 只是没人去看。带上它，2 秒一轮的 poll 天然就是自愈节拍：脱钩最多持续
        // 一个轮询周期，且不需要任何新状态。
        const actual: PaneMode = currentBuffer === "alternate" ? "alt" : "normal";
        if (mode === appliedMode && mode === actual) return; // 两边都对上才放行
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
      // 【2026-08-28 输入回底部】真终端里打字会自动滚回底部（xterm 的
      // scrollOnUserInput）。我们的输入走 RPC→tmux、不经过 xterm 的键盘
      // 事件，这个行为就静默丢了——用户向上滚过之后（手机上一拖就是一行），
      // 输入框所在的底行在视口外，而 xterm 只对视口内的脏行发重绘请求，
      // 表现正是「打字无回显、终端像卡死，关掉重开才看到」。
      try { term.scrollToBottom(); } catch { /* 显示层尽力而为，不牵连输入 */ }
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
    startStreaming = () => {
      if (!hasStreamed) {
        hasStreamed = true;
        void seedFromHistory();
        return;
      }
      void resumeFromHistory();
    };
    // 只有活动的 tab 才在挂载时 refit。非活动 tab 此刻是 display:none，量不到自己，
    // 而它上报的塌陷尺寸会把**共享的 tmux 会话**拽窄、连带污染别人的历史。
    // refit() 内部也有 isMeasurable 守卫，这里显式判 active 是让意图落在代码上：
    // 没显示出来就没有任何理由去打扰 tmux。真正显示时由下面的 ResizeObserver 补上。
    if (active) refit();
    onReady?.(sessionId, term);
    // 让外壳能对指定会话触发重灌。目前唯一的调用方是 App 的 onResync —— 服务端
    // 说「你缺了一段字节」时，只有重灌快照能补，重推当前屏补不了 scrollback。
    onReseedReady?.(sessionId, (t) => { void reloadHistory(t); });
    // The classifyPane poll is NOT started here: the visibility $effect below
    // starts it when (and only while) this terminal is active + live (A4).

    // R3: a window resize fires continuously during a drag — collapse the burst
    // into one trailing refit (~150ms). The activation/font-size paths call
    // refit directly and stay immediate.
    let resizeDebounce: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      if (!active) return;
      if (resizeDebounce) clearTimeout(resizeDebounce);
      // 挂起的收缩确认同样会 refit 一个已 dispose 的终端（同 seedTimer 的理由）。
      if (shrinkTimer) { clearTimeout(shrinkTimer); shrinkTimer = undefined; }
      resizeDebounce = setTimeout(() => {
        resizeDebounce = undefined;
        refitWhy = "observer";
        // 宽度变化后**不**重灌历史（2026-08-08）：capture-pane -J 灌进来的是
        // 软折行（isWrapped），xterm 自带的 reflow 对软折行有效（实测：40 列
        // 写 75 字符折成 2 行，resize 到 80 列合并回 1 行、内容完整）。
        // 见 lib/term/reseed.xterm.test.ts 的 reflow 断言。
        refit();
      }, 150);
    };
    window.addEventListener("resize", onResize);

    // 需求7: the divider drag changes only the container height (no window
    // resize), so observe the host directly. Reuses onResize's 150ms debounce
    // + cols-change reloadHistory. Guarded for environments without RO (jsdom).
    // 「变得可测量」这件事本身就是一次有效的 resize 信号。
    //
    // 实测：宿主隐藏时 RO 以 contentRect 0x0 触发一次，被显示时再以真实尺寸
    // (374x488) 触发一次——**浏览器会主动通知我们「现在能量了」**。这是隐藏期间
    // 唯一可靠的唤醒源（等时间没用，见 fit-guard.ts 里的实测记录）。
    //
    // 这条跃迁不能只交给 onResize：它带 150ms 防抖，而「刚可测量」应当立刻补一次，
    // 否则终端会在旧尺寸下多渲染几帧。所以 0→非 0 直接 refit，其余走原来的防抖。
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      let wasMeasurable = isMeasurable(host);
      ro = new ResizeObserver(() => {
        const now = isMeasurable(host);
        const became = !wasMeasurable && now;
        wasMeasurable = now;
        // active 守卫与 onResize 保持一致：非活动 tab 没有任何理由去打扰共享的
        // tmux 会话。它被切成活动时，下面那个 $effect 会走 activateRefit。
        if (became) { if (active) { refitWhy = "became-measurable"; refit(); } return; }
        onResize();
      });
      ro.observe(host);
    }

    // Theme switch repaints the terminal: xterm holds a copy of the colours
    // taken at construction, so without this the terminal keeps the old palette
    // until it is remounted — very visible now that the ANSI 16 and the
    // background follow the theme.
    //
    // data-theme is still the right trigger for custom themes too: `applyTheme`
    // writes `data-theme="custom:<name>"`, and it does so *after* the swapped
    // <link href="/theme/custom.css?t=…"> has finished loading (lib/theme.ts),
    // so by the time this fires the tokens are already resolvable.
    // Guarded for jsdom (no MutationObserver in some setups).
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
      // 埋点的两个订阅（2026-08-22）。心跳往一个已 dispose 的终端读 buffer 会抛，
      // onRender 订阅不撤则随每次开关会话累积。
      //
      // 【2026-08-23】这两行原先误写在 onResize 里 —— 那不是「终端没了」，那是
      // 「终端变大了」。后果是窗口一改尺寸（或分栏拖动触发 ResizeObserver）就把
      // 渲染订阅永久退掉、心跳永久清掉，此后 renderFrames 恒为 0、write 心跳彻底
      // 停摆。线上 aippt 会话据此被判成「渲染器停摆 5 次」，实为埋点自己死了：
      // 同一条记录里 pageVersions 3201→8368、bufDelta=387，屏幕明明在画。
      // 两条数据互相矛盾时，错的是恒为 0 的那条。
      clearInterval(heartbeat);
      unsubscribeRender?.();
      unexposeForDiag();
      // 卸载时挂起的首屏重试必须撤掉：它会向一个已 dispose 的终端写字节。
      cancelSeedRetry();
      stopPoll(); // also drops a pending input-debounced classify
      // Release the WebGL addon BEFORE the terminal: it also stops any pending
      // context-loss handler from rebuilding a renderer onto a dead terminal.
      webglHandle?.dispose();
      term?.dispose();
    };
    mounted = true;
  });

  // Apply stream delivery intent only after xterm and its connection callbacks
  // exist. Re-rendering the same value is a no-op; visibility changes alone do
  // not tear down a grace stream.
  $effect(() => {
    if (!mounted) return;
    if (streaming === streamingApplied) return;
    streamingApplied = streaming;
    if (streaming) startStreaming();
    else stopStreaming();
  });

  // Re-fit when this session becomes visible (xterm can't measure while hidden).
  // Flush/reseed the stashed output first (R1) so refit measures final content.
  // A4: the classifyPane poll follows visibility — activation runs one classify
  // right away (after flush + refit) and restarts the 2s cadence; hiding pauses
  // it, and a tombstone (closed/done) stops it for good.
  $effect(() => {
    if (mounted && active && !closed && term && fit) {
      flushPending();
      queueMicrotask(() => {
        activateRefit();
        // 【2026-08-28 渲染去抖器解卡】切 tab 与切 App 是同一个坑的两条入口：
        // 隐藏期间被丢弃的 rAF 句柄不清，回来后渲染请求全部 early-return。
        // refit 之后踢，让解卡触发的全量重画画的是最终尺寸的内容。
        kickRenderDebouncer(term);
        startPoll();
        // 取证（2026-08-09）：在 refit **之后**拍，量到的才是这个 tab 稳定下来的
        // 真实尺寸。列数塌陷与滑不动都只在切 tab 时复现，而这里是唯一必经之路。
        reportScroll("activate");
        // 全链路采样（2026-08-22）：切回一个 tab 是「用户正盯着这一屏」的时刻，
        // 也是故障最常被看见的时刻。此处对拍一次，日志里就有了「用户看到它的
        // 那一刻，buffer 与 tmux 到底一不一致」。
        //
        // 延后 1.5s 而不是立刻拍：激活的这一刻首屏 seed 往往还在路上（真机
        // rtt 中位 ~1.9s），此时视口是空的，拍下来只是一条「什么都没有」。
        // sampleChain 里另有空视口保护兜底，这里的延时是让它**拍到内容**而不
        // 只是不拍错。用 setTimeout 而非挂进 seed 流程：诊断不该侵入功能路径。
        const t = setTimeout(() => sampleNow("activate"), 1500);
        (t as unknown as { unref?: () => void })?.unref?.();
      });
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
      if (active) queueMicrotask(() => { refitWhy = "font-size"; refit(); });
    }
  });

  // Live-apply font-family changes: update xterm then re-fit + resize PTY.
  // **必须 refit**：不同字体的字宽不同（Ubuntu Mono 明显更窄），格子尺寸变了
  // 而不重新测量的话，xterm 算出来的 cols/rows 与实际能显示的对不上，
  // 表现为右边一列被切掉或多出一条空白，且 PTY 尺寸也跟着错。
  $effect(() => {
    void fontFamily; // 依赖声明：prop 变了就重跑
    if (!term || !fit) return;
    const chain = termFontFamily();
    if (term.options.fontFamily === chain) return; // 同一套字体，什么都不用做
    term.options.fontFamily = chain;
    if (active) queueMicrotask(() => { refitWhy = "font-family"; refit(); });
  });
</script>

<div class="term-wrap" class:hidden={!active}>
  <div class="term" class:closed bind:this={host}></div>
  {#if seeding || seedRetrying}
    <div class="term-seed">
      <span>{seedRetrying ? $t('terminal.seedRetrying') : $t('terminal.seeding')}</span>
      <!-- delayMs={0}：这条路径**已知必然慢**（tmux capture + gzip + 可能分片），
           不需要延迟判断。 -->
      <ProgressLine delayMs={0} />
    </div>
  {:else if seedFailed}
    <!-- 首屏重试用尽（2026-08-18）。此前这里什么都不显示，用户看到的是一个
         永远空白、毫无线索的终端，只能靠关掉重开撞运气。pointer-events 要放开，
         否则按钮点不动（.term-seed 上是 none）。 -->
    <div class="term-seed term-seed-failed">
      <span>{$t('terminal.seedFailed')}</span>
      <button class="term-seed-retry" type="button" onclick={() => retrySeed()}>{$t('terminal.seedRetry')}</button>
    </div>
  {/if}
</div>

<style>
  .term-wrap { position: relative; width: 100%; height: 100%; }
  /* 首屏读取历史时的极淡提示。居中偏上，不遮挡将要出现的第一行输出。 */
  .term-seed {
    position: absolute; left: 0; right: 0; top: 38%;
    display: flex; flex-direction: column; align-items: center; gap: 10px;
    padding: 0 24px;
    color: var(--dim); font-size: 0.72rem;
    pointer-events: none;
  }
  .term-seed :global(.pl) { max-width: 180px; }
  /* 失败态要能点，所以单独放开 pointer-events（.term-seed 整体是 none）。 */
  .term-seed-failed { pointer-events: auto; }
  .term-seed-retry {
    padding: 6px 16px;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    background: var(--panel);
    color: var(--text);
    font: inherit;
    font-size: 0.78rem;
  }
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
