<script lang="ts">
  import { onMount } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { Connection } from "../lib/connection";

  let {
    conn,
    sessionId,
    active,
    closed = false,
    onReady,
  }: {
    conn: Connection;
    sessionId: string;
    active: boolean;
    closed?: boolean;
    onReady?: (sessionId: string, term: Terminal) => void;
  } = $props();

  let host: HTMLDivElement;
  let term: Terminal;
  let fit: FitAddon;

  onMount(() => {
    term = new Terminal({ fontSize: 14, convertEol: false, cursorBlink: true, disableStdin: true });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    const unsubscribeOutput = conn.onOutput((f) => {
      if (f.sessionId === sessionId) term.write(f.data);
    });

    // Session is created by App (SessionTabs "new"); here we only attach + size.
    // Input is routed by the custom keyboard (S5b) through conn.sendInput —
    // xterm is display-only.
    conn.attach(sessionId);
    conn.resize(sessionId, term.cols, term.rows);
    onReady?.(sessionId, term);

    const onResize = () => {
      if (!active) return;
      fit.fit();
      conn.resize(sessionId, term.cols, term.rows);
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
      queueMicrotask(() => { fit.fit(); conn.resize(sessionId, term.cols, term.rows); });
    }
  });
</script>

<div class="term" class:hidden={!active} bind:this={host}></div>

<style>
  .term { width: 100%; height: 100%; background: #000; }
  .hidden { display: none; }
</style>
