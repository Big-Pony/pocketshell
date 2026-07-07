<script lang="ts">
  import { onMount } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { Connection } from "../lib/connection";
  import { fromB64 } from "../lib/bytes";
  import { virtualRows, scrollMode, type BufferType } from "../lib/terminal-view";

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

  // Assigned in onMount; callable from $effect blocks that react to active/font.
  let refit: () => void = () => {};

  onMount(async () => {
    // Ensure the bundled JetBrains Mono is ready before xterm measures cells.
    // Falls back silently if the font is unavailable or the API is missing.
    try {
      await document.fonts.load(`${fontSize}px "JetBrains Mono"`);
    } catch {
      // ignore
    }

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
        background: "#1c242c",
        foreground: "#c8d3dc",
        cursor: "#46d0b4",
        selectionBackground: "rgba(106, 169, 232, 0.28)",
      },
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    // --- display mode: normal (shell) vs alternate (full-screen app) ---
    let currentBuffer: BufferType = "normal";
    let followBottom = true;

    const dims = () => fit.proposeDimensions() ?? { cols: term.cols, rows: term.rows };

    // Recompute rows/cols for the current buffer and push to xterm + PTY.
    // normal → visible rows; alternate → visible rows x3 (content overflows the
    // viewport and the outer container scrolls to reveal it).
    refit = () => {
      const d = dims();
      const rows = virtualRows(d.rows, currentBuffer);
      if (term.cols !== d.cols || term.rows !== rows) term.resize(d.cols, rows);
      conn.resize(sessionId, d.cols, rows);
      const container = scrollMode(currentBuffer) === "container";
      host.classList.toggle("alt-scroll", container);
      if (container && followBottom) host.scrollTop = host.scrollHeight;
    };

    // In the alternate buffer xterm converts wheel events into arrow keys; return
    // false so the event bubbles to the outer container and scrolls it instead.
    term.attachCustomWheelEventHandler(() => currentBuffer !== "alternate");

    // Keep the alt-mode container pinned to the bottom unless the user scrolled up.
    host.addEventListener("scroll", () => {
      if (currentBuffer !== "alternate") return;
      followBottom = host.scrollTop + host.clientHeight >= host.scrollHeight - 4;
    });

    const unsubscribeOutput = conn.onOutput((f) => {
      if (f.sessionId !== sessionId) return;
      term.write(f.data, () => {
        if (currentBuffer === "alternate" && followBottom) host.scrollTop = host.scrollHeight;
      });
    });

    // Switch policy when the app enters/leaves the alternate screen.
    term.buffer.onBufferChange((buf) => {
      currentBuffer = (buf.type as BufferType) === "alternate" ? "alternate" : "normal";
      followBottom = true;
      refit();
      if (currentBuffer === "normal") void reloadHistory(); // back to shell → re-seed
    });

    // Re-seed history (used on cols change and on returning to the shell). xterm
    // wraps history to the current cols, so a width change invalidates it.
    let lastCols = term.cols;
    const reloadHistory = async () => {
      if (currentBuffer !== "normal") return;
      try {
        const h = (await conn.rpc("term.history", { session: sessionId })) as { data: string };
        term.clear();
        if (h?.data) term.write(fromB64(h.data));
      } catch { /* best-effort */ }
    };

    // Seed history BEFORE live attach (moved here from Task 3's inline block).
    try {
      const h0 = (await conn.rpc("term.history", { session: sessionId })) as { data: string };
      if (h0?.data) term.write(fromB64(h0.data));
    } catch { /* ignore */ }

    // Session is created by App (SessionTabs "new"); here we only attach + size.
    // Input is routed by the custom keyboard (S5b) through conn.sendInput —
    // xterm is display-only.
    conn.attach(sessionId);
    refit();
    onReady?.(sessionId, term);

    const onResize = () => {
      if (!active) return;
      refit();
      if (term.cols !== lastCols) { lastCols = term.cols; void reloadHistory(); }
    };
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      unsubscribeOutput?.();
      term?.dispose();
    };
  });

  // Re-fit when this session becomes visible (xterm can't measure while hidden).
  $effect(() => {
    if (active && term && fit) {
      queueMicrotask(() => refit());
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
  /* Alternate-screen (full-screen app): xterm overflows the viewport at 3x rows;
     let the outer container scroll to reveal content above/below the fold. */
  .term:global(.alt-scroll) {
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
  }
  .hidden { display: none; }
  .closed { opacity: 0.6; }
</style>
