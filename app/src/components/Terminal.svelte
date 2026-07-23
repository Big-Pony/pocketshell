<script module lang="ts">
  // R1 (hidden terminals): output that arrives while the terminal is inactive
  // must not pay xterm's parse/render cost, so the raw bytes are stashed here
  // and flushed as one concatenated write on activation. A hard cap bounds
  // memory for chatty sessions: past the limit the stash is dropped and marked
  // dirty, and activation reseeds from a full tmux snapshot instead of
  // replaying a truncated byte stream.
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
</script>

<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { Connection } from "../lib/connection";
  import { fromB64 } from "../lib/bytes";

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
      scrollback: 5000,
      unicodeVersion: "11",
      convertEol: false,
      cursorBlink: true,
      disableStdin: true,
      theme: {
        // 终端区两套主题均为深色（--term-bg/--term-text），此处与之保持一致
        background: "#0c1017",
        foreground: "#c6d0dc",
        cursor: "#3ecf94",
        selectionBackground: "rgba(110, 168, 254, 0.28)",
      },
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
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
    const reloadHistory = async () => {
      if (currentBuffer !== "normal") return;
      try {
        const h = (await conn.rpc("term.history", { session: sessionId })) as { data: string };
        term.clear();
        // capture-pane lines are trimmed and bare-\n separated; xterm runs with
        // convertEol:false, so a bare \n moves down WITHOUT returning to column
        // 0 and the reseed renders as a diagonal staircase (visible after `:q`
        // from vim, where no live repaint masks it). Normalize to \r\n.
        if (h?.data) term.write(new TextDecoder().decode(fromB64(h.data)).replace(/\n/g, "\r\n"));
      } catch { /* best-effort */ }
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
      // Bypass the R3 suppression guard so conn.resize always goes out on
      // activation, pulling the shared tmux window to this device's size.
      lastSentCols = -1;
      lastSentRows = -1;
      refit();
      if (currentBuffer === "normal") void reloadHistory();
      else void conn.rpc("term.redraw", { session: sessionId }).catch(() => {});
    };

    // Poll tmux's real alternate_on state and switch xterm's buffer to match,
    // ONLY on an actual change (edge-triggered). tmux does not forward 1049h/1049l
    // to an attach client, so we drive the buffer ourselves. Re-seeding history on
    // every poll would clear+redraw the whole screen every 2s and race the live
    // stream, so history is (re)seeded only on the edge into the normal buffer and
    // on a cols change.
    let paneInfoSeq = 0;
    let appliedMode: PaneMode | null = null;
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

    // Session is created by App (SessionTabs "new"); here we only attach + size.
    // Input is routed by the custom keyboard (S5b) through conn.sendInput —
    // xterm is display-only.
    conn.attach(sessionId);
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

    teardown = () => {
      window.removeEventListener("resize", onResize);
      unsubscribeOutput?.();
      unsubscribeInput?.();
      if (resizeDebounce) clearTimeout(resizeDebounce);
      stopPoll(); // also drops a pending input-debounced classify
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
