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
  /* 二维码必须黑模块+白底，且四周留白（QR 规范的 quiet zone），否则手机相机扫不出。
     白底写死 #fff 是扫码识别的功能前提，不是配色——不要改成主题令牌，也不要加 filter 反相。 */
  .qr img {
    box-sizing: content-box; /* 全局 border-box 会把 padding 吃进 104px，导致码变小 */
    background: #fff;
    padding: 8px;
    border-radius: 6px;
  }

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

  /*
   * 手机框跟着视口高度伸缩，宽度由 390:844 的比例算出来。
   *
   * 之前是写死的 390×844：加上 10px 边框和 .stage 的 40px 上下留白，一共要
   * 944px，而常见笔电视口只有 ~800-900px——框底被切掉，页面还多出竖向滚动。
   * 原来的 @media 只看**宽度**，所以宽屏矮窗（笔电全屏、浏览器带书签栏）根本
   * 不触发。
   *
   *   上限 844px：再高也不放大，免得在大屏上变成一台失真的巨型手机
   *   下限 600px：800px 高的窗口（1080p 屏 + 书签栏，很常见）在 700px 下限时
   *     正好溢出——80 留白 + 20 边框 + 700 = 800，一点余量没有，框底被切。
   *     600px 让 760px 以上的窗口都能完整放下，代价是 app 布局略挤但仍可用。
   *   之间：100dvh 减掉边框与留白，能给多少给多少
   */
  .phone {
    /* 一处算出高度，宽度乘比例跟随——两处各写一遍 clamp 迟早漂移。 */
    /* 160px = .stage 留白 40×2 + 边框 10×2 + 60px。那 60px 是实测补的：app 底部
       的键盘/工具条那一段不在 iframe 的 100% 高度账里（安全区 + 底栏），只按
       100px 扣的话框底那一截 tab 会被切掉。 */
    --phone-h: clamp(600px, calc(100dvh - 160px), 844px);
    height: var(--phone-h);
    width: calc(var(--phone-h) * 390 / 844);
    border: 10px solid var(--line);
    border-radius: 38px;
    overflow: hidden;
    background: var(--bg-deep);
    box-shadow: var(--pop-shadow);
    box-sizing: content-box;          /* 高度是内容区（iframe）的，边框另算 */
    flex: none;                       /* 竖排时别被 flex 压扁 */
  }
  .phone iframe { width: 100%; height: 100%; border: 0; display: block; }

  /* 窄桌面（或缩放）改竖排。高度已由上面的 clamp 管住，这里只管排列方向；
     不再用 transform: scale + 负 margin 那套魔法数字——它撑出的空白高度和视觉
     高度对不上，正是竖排下多出一截滚动的原因。 */
  @media (max-width: 1100px) {
    .stage { flex-direction: column; gap: 32px; }
  }
</style>
