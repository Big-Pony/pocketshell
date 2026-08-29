<script lang="ts">
  let { sessionId, active, streaming }: {
    sessionId: string;
    active: boolean;
    streaming: boolean;
  } = $props();
</script>

<div
  data-testid="terminal-{sessionId}"
  data-active={String(active)}
  data-streaming={String(streaming)}
></div>
