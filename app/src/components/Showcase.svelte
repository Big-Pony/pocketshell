<script lang="ts">
  // 桌面展台页。左侧介绍，右侧 390×844 手机外框里嵌真正的 app。
  //
  // iframe 同源，所以：① 主题靠共享 localStorage + storage 事件同步，不需要
  // 消息桥；② 「试试断网」用 postMessage 打进框内（App.svelte 那侧在听）。
  import { onMount } from "svelte";
  import { t } from "svelte-i18n";
  import { initTheme } from "../lib/theme";

  let frame: HTMLIFrameElement | undefined = $state();

  function tryOffline() {
    frame?.contentWindow?.postMessage({ source: "pocketshell-demo", action: "drop" }, location.origin);
  }

  onMount(() => {
    // 访客在框内切主题时 ps.settings 变了，storage 事件会派发到本文档。
    const onStorage = (e: StorageEvent) => { if (e.key === "ps.settings") initTheme(); };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  });
</script>

<main class="stage">
  <section class="pitch">
    <h1>{$t("demo.showcase.title")}</h1>
    <p class="lede">{$t("demo.showcase.lede")}</p>

    <ul class="sell">
      <li>{$t("demo.showcase.sell1")}</li>
      <li>{$t("demo.showcase.sell2")}</li>
      <li>{$t("demo.showcase.sell3")}</li>
    </ul>

    <div class="try">
      <div class="try-h">{$t("demo.showcase.tryTitle")}</div>
      <ol>
        <li>{$t("demo.showcase.try1")}</li>
        <li><button class="linkish" onclick={tryOffline}>{$t("demo.showcase.try2")}</button></li>
        <li>{$t("demo.showcase.try3")}</li>
        <li>{$t("demo.showcase.try4")}</li>
      </ol>
    </div>

    <div class="qr">
      <img src="/qr-demo.svg" width="104" height="104" alt="" />
      <span>{$t("demo.showcase.qrHint")}</span>
    </div>

    <div class="cta">
      <a class="btn primary" href="https://pocketshell.net/#quickstart" target="_blank" rel="noopener">{$t("demo.showcase.install")}</a>
      <a class="btn" href="https://github.com/Big-Pony/pocketshell" target="_blank" rel="noopener">{$t("demo.showcase.github")}</a>
      <a class="btn ghost" href="/app">{$t("demo.showcase.openFull")}</a>
    </div>
  </section>

  <section class="device">
    <div class="phone">
      <iframe bind:this={frame} src="/app" title={$t("demo.showcase.frameLabel")}></iframe>
    </div>
  </section>
</main>

<style>
  /* 全部走语义令牌，六套主题自动适配（CLAUDE.md 第 4 条）。 */
  .stage {
    min-height: 100dvh;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 56px;
    padding: 40px 32px;
    background:
      radial-gradient(130% 55% at 50% -8%, var(--shell-glow), transparent 62%),
      var(--bg);
    color: var(--text);
    box-sizing: border-box;
  }
  .pitch { max-width: 460px; }
  h1 { font-size: 1.6rem; margin: 0 0 10px; }
  .lede { color: var(--dim); margin: 0 0 22px; line-height: 1.6; }

  .sell { list-style: none; padding: 0; margin: 0 0 26px; }
  .sell li {
    position: relative;
    padding-left: 18px;
    margin-bottom: 9px;
    line-height: 1.55;
  }
  .sell li::before {
    content: "";
    position: absolute;
    left: 0; top: 8px;
    width: 6px; height: 6px;
    border-radius: 50%;
    background: var(--ok);
  }

  .try {
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 14px 16px;
    margin-bottom: 22px;
    background: var(--panel);
  }
  .try-h { font-size: 0.78rem; color: var(--dim); margin-bottom: 8px; letter-spacing: 0.04em; }
  .try ol { margin: 0; padding-left: 18px; }
  .try li { margin-bottom: 6px; line-height: 1.5; }

  .linkish {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: var(--accent);
    cursor: pointer;
    text-align: left;
    text-decoration: underline;
  }

  .qr {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: 24px;
    font-size: 0.82rem;
    color: var(--dim);
  }
  /* 二维码是黑色描边的 SVG；深色主题下反相才看得清。 */
  :global(html[data-scheme="dark"]) .qr img { filter: invert(1); }

  .cta { display: flex; flex-wrap: wrap; gap: 10px; }
  .btn {
    display: inline-block;
    padding: 8px 15px;
    border-radius: 8px;
    border: 1px solid var(--line);
    color: var(--text);
    text-decoration: none;
    font-size: 0.85rem;
  }
  .btn.primary {
    background: var(--primary-bg);
    color: var(--primary-text);
    border-color: var(--primary-bg);
  }
  .btn.ghost { color: var(--dim); }

  .phone {
    width: 390px;
    height: 844px;
    border: 10px solid var(--line);
    border-radius: 38px;
    overflow: hidden;
    background: var(--bg-deep);
    box-shadow: var(--pop-shadow);
  }
  .phone iframe { width: 100%; height: 100%; border: 0; display: block; }

  /* 窄一点的桌面（或缩放）下改成竖排，手机框整体缩小，不出现横向滚动。 */
  @media (max-width: 1100px) {
    .stage { flex-direction: column; gap: 32px; }
    .phone { transform: scale(0.78); transform-origin: top center; margin-bottom: -180px; }
  }
</style>
