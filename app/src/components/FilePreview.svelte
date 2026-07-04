<script lang="ts">
  import { Connection } from "../lib/connection";
  import { splitLines, highlightTo } from "../lib/highlight";

  let { conn, path, mode, active }: {
    conn: Connection; path: string; mode: "code" | "diff"; active: boolean;
  } = $props();

  let lines = $state<string[]>([]);
  let htmlLines = $state<string[]>([]);
  let hunks = $state<{ header: string; lines: { kind: "add" | "del" | "ctx"; text: string }[] }[]>([]);
  let notice = $state("");
  let loaded = "";

  async function load() {
    notice = "";
    if (mode === "diff") {
      try {
        const r = (await conn.rpc("fs.diff", { path })) as { hunks: typeof hunks };
        hunks = r.hunks;
        if (!hunks.length) notice = "无改动";
      } catch (e: any) {
        notice = e?.message ?? "diff 失败";
        hunks = [];
      }
      return;
    }
    try {
      const r = (await conn.rpc("fs.read", { path })) as { content: string; lang: string; truncated?: boolean; binary?: boolean };
      if (r.binary) { notice = "二进制文件，不预览"; lines = []; htmlLines = []; return; }
      if (r.truncated) notice = "已截断，仅显示前若干行";
      lines = splitLines(r.content);
      const html = await highlightTo(r.lang, r.content);
      htmlLines = html.split("\n");
    } catch (e: any) {
      notice = e?.message ?? "读取失败";
      lines = []; htmlLines = [];
    }
  }

  $effect(() => { if (active && loaded !== path + mode) { loaded = path + mode; void load(); } });
</script>

<div class="preview" class:hidden={!active}>
  {#if notice}<div class="pv-notice">{notice}</div>{/if}
  {#if mode === "diff"}
    <div class="diff">
      {#each hunks as h}
        <div class="hh mono">{h.header}</div>
        {#each h.lines as l}<div class="dl {l.kind}"><span class="sign">{l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}</span>{l.text}</div>{/each}
      {/each}
    </div>
  {:else}
    <pre class="code"><code>{#each htmlLines as ln, i}<span class="ln">{i + 1}</span><span class="lc">{@html ln}
</span>{/each}</code></pre>
  {/if}
</div>

<style>
  .preview { width: 100%; height: 100%; overflow: auto; background: var(--panel2); }
  .hidden { display: none; }
  .pv-notice { font-size: 0.7rem; color: var(--amber); padding: 6px 10px; background: var(--panel); }
  .code { margin: 0; padding: 8px 4px; font-size: 0.72rem; line-height: 1.5; font-family: "SF Mono", ui-monospace, Menlo, monospace; }
  .ln { display: inline-block; width: 3.2em; text-align: right; padding-right: 1em; color: var(--dimmer); user-select: none; }
  .lc { white-space: pre; }
  .diff { padding: 8px 4px; font-size: 0.72rem; line-height: 1.5; font-family: "SF Mono", ui-monospace, Menlo, monospace; }
  .hh { color: var(--amber); margin: 6px 0 2px; }
  .dl { white-space: pre; }
  .dl.add { color: var(--teal); }
  .dl.del { color: var(--red); }
  .dl.ctx { color: var(--dim); }
  .sign { display: inline-block; width: 1em; user-select: none; }
</style>
