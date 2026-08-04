<script lang="ts">
  import { t } from "svelte-i18n";
</script>

<main class="stage">
  <h1>{$t("demo.showcase.title")}</h1>
</main>

<style>
  .stage {
    min-height: 100dvh;
    background: var(--bg);
    color: var(--text);
  }
</style>
