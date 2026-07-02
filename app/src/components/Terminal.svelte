<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { Connection } from "../lib/connection";

  let { conn, sessionId }: { conn: Connection; sessionId: string } = $props();

  let host: HTMLDivElement;
  let term: Terminal;
  let fit: FitAddon;

  onMount(() => {
    term = new Terminal({ fontSize: 14, convertEol: false, cursorBlink: true });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    // Render bytes for this session as they arrive.
    let unsubscribeOutput: (() => void) | undefined = conn.onOutput((f) => {
      if (f.sessionId === sessionId) term.write(f.data);
    });

    // Ensure the session exists, then attach and size it to the viewport.
    conn.newSession(sessionId);
    conn.attach(sessionId);
    conn.resize(sessionId, term.cols, term.rows);

    // Send keystrokes as raw bytes.
    term.onData((data: string) => {
      conn.sendInput(sessionId, new TextEncoder().encode(data));
    });

    const onResize = () => {
      fit.fit();
      conn.resize(sessionId, term.cols, term.rows);
    };
    window.addEventListener("resize", onResize);
    onDestroy(() => {
      window.removeEventListener("resize", onResize);
      unsubscribeOutput?.();
    });
  });

  onDestroy(() => term?.dispose());
</script>

<div class="term" bind:this={host}></div>

<style>
  .term {
    width: 100%;
    height: 100dvh;
    background: #000;
  }
</style>
