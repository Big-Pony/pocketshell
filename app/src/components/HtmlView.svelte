<script lang="ts">
  let { src }: { src: string } = $props();
</script>

<!-- allow-scripts WITHOUT allow-same-origin: page JS runs in an opaque origin
     and cannot reach the parent window / App identity keys. -->
<iframe class="html-frame" title="preview" {src} sandbox="allow-scripts"></iframe>

<style>
  .html-frame { width: 100%; height: 100%; border: 0; background: #fff; }
</style>
