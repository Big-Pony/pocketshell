<script lang="ts">
  import TerminalView from "./components/Terminal.svelte";
  import { Connection } from "./lib/connection";

  // Slice-1 wiring: single hardcoded session against a local agent.
  const url = `ws://${location.hostname}:8722`;
  const conn = new Connection({ url });
  const sessionId = "main";
</script>

<TerminalView {conn} {sessionId} />
