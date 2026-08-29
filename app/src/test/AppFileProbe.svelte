<script lang="ts">
  let { path, active }: { path: string; active: boolean } = $props();
</script>

<div data-testid="file-{path}" data-active={String(active)}></div>
