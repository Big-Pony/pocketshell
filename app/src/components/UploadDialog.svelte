<script lang="ts">
  import { Connection } from "../lib/connection";
  import { uploadFiles, humanSize, MAX_TRANSFER_BYTES, type UploadItem } from "../lib/transfer";

  let { conn, dir, onClose, onUploaded }: {
    conn: Connection; dir: string; onClose: () => void; onUploaded: (dir: string) => void;
  } = $props();

  type Phase = "selecting" | "conflict" | "uploading" | "done" | "error";
  type Choice = "overwrite" | "skip" | "rename";
  type Sel = { name: string; size: number; blob: File; tooBig: boolean };

  let phase = $state<Phase>("selecting");
  let files = $state<Sel[]>([]);
  let conflicts = $state<string[]>([]);
  let choices = $state<Record<string, Choice>>({});
  let uploaded = $state(0);
  let total = $state(0);
  let errMsg = $state("");
  let cancelled = false;
  let input = $state<HTMLInputElement | null>(null);

  const anyTooBig = $derived(files.some((f) => f.tooBig));

  function pick() { input?.click(); }
  function onPicked(e: Event) {
    const list = (e.target as HTMLInputElement).files;
    if (!list) return;
    const add: Sel[] = [];
    for (const f of Array.from(list)) {
      if (files.some((x) => x.name === f.name && x.size === f.size)) continue; // dedupe by name+size
      add.push({ name: f.name, size: f.size, blob: f, tooBig: f.size > MAX_TRANSFER_BYTES });
    }
    files = [...files, ...add];
    if (input) input.value = ""; // allow re-picking same file
  }

  async function start() {
    if (!files.length || anyTooBig) return;
    const names = files.map((f) => f.name);
    try {
      const r = (await conn.rpc("fs.uploadCheck", { dir, names })) as { conflicts: string[] };
      conflicts = r.conflicts;
    } catch (e: any) { errMsg = e?.message ?? "检查失败"; phase = "error"; return; }
    if (conflicts.length) {
      choices = Object.fromEntries(conflicts.map((n) => [n, "rename" as Choice]));
      phase = "conflict";
    } else { void run(); }
  }

  function applyAll(c: Choice) { choices = Object.fromEntries(conflicts.map((n) => [n, c])); }

  async function run() {
    phase = "uploading";
    uploaded = 0; total = 0; cancelled = false;
    // Resolve each file's destination name per conflict choice.
    const items: UploadItem[] = [];
    for (const f of files) {
      const c = conflicts.includes(f.name) ? choices[f.name] : "overwrite";
      if (c === "skip") continue;
      let destName = f.name;
      if (c === "rename") {
        try { destName = ((await conn.rpc("fs.resolveName", { dir, name: f.name })) as { name: string }).name; }
        catch (e: any) { errMsg = e?.message ?? "命名失败"; phase = "error"; return; }
      }
      items.push({ name: f.name, size: f.size, blob: f.blob, destName });
    }
    total = items.reduce((s, it) => s + it.size, 0);
    try {
      await uploadFiles(conn, dir, items, {
        onProgress: (u, t) => { uploaded = u; total = t; },
        shouldCancel: () => cancelled,
      });
      if (cancelled) { onClose(); return; }
      phase = "done";
      onUploaded(dir);
    } catch (e: any) { errMsg = e?.message ?? "上传失败"; phase = "error"; }
  }

  function close() { cancelled = true; onClose(); }
</script>

<div class="backdrop" role="dialog" aria-modal="true">
  <div class="dlg">
    <div class="hd">
      <span>上传到 {dir}</span>
      <button class="x" aria-label="关闭" onclick={close}>✕</button>
    </div>

    <input bind:this={input} type="file" multiple style="display:none" onchange={onPicked} />

    {#if phase === "selecting"}
      <div class="list">
        {#each files as f (f.name + f.size)}
          <div class="item" class:bad={f.tooBig}>
            <span class="nm">{f.name}</span>
            <span class="sz">{humanSize(f.size)}{f.tooBig ? " · 超 200MB" : ""}</span>
          </div>
        {/each}
        {#if !files.length}<div class="empty">未选择文件</div>{/if}
      </div>
      <div class="btns">
        <button onclick={pick}>继续选择</button>
        <button onclick={close}>取消</button>
        <button class="primary" disabled={!files.length || anyTooBig} onclick={start}>上传</button>
      </div>
    {:else if phase === "conflict"}
      <div class="hint">以下文件已存在，请选择处理方式</div>
      <div class="btns">
        <button onclick={() => applyAll("overwrite")}>全部覆盖</button>
        <button onclick={() => applyAll("skip")}>全部跳过</button>
        <button onclick={() => applyAll("rename")}>全部重命名</button>
      </div>
      <div class="list">
        {#each conflicts as n (n)}
          <div class="item">
            <span class="nm">{n}</span>
            <select bind:value={choices[n]}>
              <option value="overwrite">覆盖</option>
              <option value="skip">跳过</option>
              <option value="rename">重命名</option>
            </select>
          </div>
        {/each}
      </div>
      <div class="btns">
        <button onclick={() => (phase = "selecting")}>返回</button>
        <button class="primary" onclick={run}>开始上传</button>
      </div>
    {:else if phase === "uploading"}
      <div class="prog">已上传 {humanSize(uploaded)} / {humanSize(total)}</div>
      <div class="hint">关闭弹窗即取消上传</div>
    {:else if phase === "done"}
      <div class="prog ok">上传完成 · {humanSize(total)}</div>
      <div class="btns"><button class="primary" onclick={onClose}>关闭</button></div>
    {:else}
      <div class="prog err">{errMsg}</div>
      <div class="btns"><button onclick={onClose}>关闭</button></div>
    {/if}
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; z-index: 40; background: rgba(7,9,11,0.75); display: grid; place-items: center; }
  .dlg { background: #1c2530; border: 1px solid var(--line); border-radius: 14px; padding: 16px; width: min(340px, 88vw); }
  .hd { display: flex; justify-content: space-between; align-items: center; font-size: 0.8rem; margin-bottom: 10px; }
  .x { background: transparent; border: 0; color: var(--dim); font-size: 0.9rem; }
  .list { max-height: 40vh; overflow-y: auto; margin: 6px 0; }
  .item { display: flex; justify-content: space-between; gap: 8px; padding: 6px 4px; font-size: 0.72rem; border-bottom: 1px solid var(--line); }
  .item.bad { color: var(--red); }
  .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sz { flex: 0 0 auto; color: var(--dim); }
  .empty { color: var(--dim); font-size: 0.72rem; padding: 10px 0; text-align: center; }
  .btns { display: flex; gap: 8px; margin-top: 10px; }
  .btns button { flex: 1; padding: 8px 0; border-radius: var(--radius-md); border: 1px solid var(--line); background: var(--key); color: var(--text); font-size: 0.73rem; }
  .btns button.primary { background: var(--teal); color: #06231f; border-color: transparent; }
  .btns button:disabled { opacity: 0.5; }
  .prog { font-size: 0.78rem; text-align: center; padding: 14px 0; }
  .prog.ok { color: var(--teal); } .prog.err { color: var(--red); }
  .hint { font-size: 0.68rem; color: var(--amber); text-align: center; }
  select { background: var(--panel2); color: var(--text); border: 1px solid var(--line); border-radius: 6px; font-size: 0.7rem; }
</style>
