<!-- app/src/components/KeyboardTutorial.svelte -->
<!-- 切到 layered / flick 时弹一次，讲清该布局唯一需要学的那件事。
     classic 不弹——它是默认值，也没有新概念。
     动画是纯 CSS 循环，无 JS、无外部资源。 -->
<script lang="ts">
  import { t } from "svelte-i18n";
  import type { TutorialId } from "../lib/term/kb-tutorial";

  let { tutorial, onClose }: { tutorial: TutorialId; onClose: () => void } = $props();

  const name = $derived($t(`settings.kbLayout.${tutorial}`));
</script>

<div class="kt-mask" role="dialog" aria-modal="true" tabindex="-1"
  onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}
  onkeydown={(e) => { if (e.key === "Escape") onClose(); }}>
  <div class="kt-card">
    <h3>{$t('kbTutorial.switched', { values: { name } })}</h3>

    {#if tutorial === "layered"}
      <!-- 手指点 123 键（只压键的右下角，不遮键帽字），上排从字母翻成数字 -->
      <div class="stage demo-layered" aria-hidden="true">
        <div class="swap letters"><span>a</span><span>s</span><span>d</span><span>f</span></div>
        <div class="swap digits"><span>1</span><span>2</span><span>3</span><span>4</span></div>
        <div class="layerkey">123</div>
        <div class="finger"></div>
      </div>
      <p><b>{$t('kbTutorial.layeredLead')}</b>{$t('kbTutorial.layeredBody')}</p>
      <p class="note">{$t('kbTutorial.layeredNote')}</p>
    {:else}
      <!-- 一个 6s 循环演示两个方向：前半上滑出 [，后半下滑出 {。
           用 v 键而不是随便一个键——[ 与 { 是一对 Shift 组合，正好把
           「同一个键的上下两符号成对」这条规则演给用户看。 -->
      <div class="stage demo-flick" aria-hidden="true">
        <div class="trail up"></div>
        <div class="trail down"></div>
        <div class="fly up">[</div>
        <div class="fly down">&#123;</div>
        <div class="dk"><span class="sub up">[</span>v<span class="sub down">&#123;</span></div>
        <div class="finger"></div>
      </div>
      <p><b>{$t('kbTutorial.flickLead')}</b>{$t('kbTutorial.flickBody')}</p>
      <p class="note">{$t('kbTutorial.flickNote')}</p>
    {/if}

    <div class="btns">
      <button class="skip" onclick={onClose}>{$t('kbTutorial.ok')}</button>
      <button class="go" onclick={onClose}>{$t('kbTutorial.go')}</button>
    </div>
  </div>
</div>

<style>
  .kt-mask {
    position: fixed; inset: 0; z-index: 60; background: var(--overlay-bg);
    display: flex; align-items: center; justify-content: center; padding: 24px;
  }
  .kt-card {
    width: 100%; max-width: 330px;
    background: var(--dlg-bg); border: 1px solid var(--line);
    border-radius: var(--radius-lg); padding: 18px 16px 14px;
    box-shadow: var(--pop-shadow);
    display: flex; flex-direction: column; gap: 12px;
  }
  h3 { margin: 0; font-size: 0.92rem; font-weight: 700; color: var(--text); }
  p { margin: 0; font-size: 0.74rem; line-height: 1.65; color: var(--dim); }
  p b { color: var(--accent-text); font-weight: 700; }
  p.note { opacity: 0.75; }
  .btns { display: flex; gap: 8px; }
  .btns button { flex: 1; border: 0; border-radius: var(--radius-md); padding: 11px 0; font: inherit; font-size: 0.76rem; }
  .go { background: var(--primary-bg); color: var(--primary-text); font-weight: 700; }
  .skip { background: var(--key); color: var(--text); }

  /* ---- 动画舞台 ----
     内部统一绝对定位，不与 flex 居中混用：混用会让键落在 flex 中心、
     而手指/飞字按 bottom 算，两套坐标对不上，几个元素会叠成一团看不出手势。 */
  .stage {
    background: var(--bg); border: 1px solid var(--line);
    border-radius: var(--radius-md); min-height: 150px;
    position: relative; overflow: hidden;
  }
  .stage span, .dk, .layerkey {
    background: var(--key); color: var(--key-text);
    border: 1px solid var(--key-line); border-radius: var(--radius-sm);
    box-shadow: var(--key-shadow), var(--key-inset);
    display: inline-flex; align-items: center; justify-content: center;
    width: 40px; height: 46px; font-size: 0.95rem;
  }
  .finger {
    position: absolute; width: 30px; height: 30px; border-radius: 50%;
    background: var(--accent-soft); border: 2px solid var(--accent);
    transform: translate(-50%, -50%); pointer-events: none; z-index: 3;
  }

  /* layered：键组原地淡入淡出翻成数字 */
  .swap {
    position: absolute; left: 50%; top: 34px; transform: translateX(-50%);
    display: flex; gap: 4px;
  }
  .letters { animation: ktFadeOut 3s infinite; }
  .digits { animation: ktFadeIn 3s infinite; }
  @keyframes ktFadeOut { 0%,32% { opacity: 1 } 42%,92% { opacity: 0 } 100% { opacity: 1 } }
  @keyframes ktFadeIn { 0%,32% { opacity: 0 } 42%,92% { opacity: 1 } 100% { opacity: 0 } }
  .layerkey {
    position: absolute; bottom: 12px; left: 26%; transform: translateX(-50%);
    width: 48px; font-size: 0.68rem; color: var(--dim); background: var(--key-mod-bg);
    animation: ktPress 3s infinite;
  }
  @keyframes ktPress {
    0%,26% { background: var(--key-mod-bg); }
    32%,40% { background: var(--accent); color: var(--on-accent); }
    48%,100% { background: var(--key-mod-bg); }
  }
  .demo-layered .finger { animation: ktTap 3s infinite; }
  @keyframes ktTap {
    0%,10% { left: 48%; top: 112%; opacity: 0; }
    20% { left: 41%; top: 96%; opacity: 0.9; }
    30%,56% { left: 37%; top: 88%; opacity: 1; }
    76%,100% { left: 37%; top: 88%; opacity: 0; }
  }

  /* flick：一个 6s 循环演示两个方向 —— 0–50% 上滑，50–100% 下滑。
     键固定在舞台竖直中央（不再贴底），上下都要留出飞行距离。
     两个方向共用一条时间轴、各自延后半程，所以所有 flick 动画都是 6s：
     改时长要整组一起改，单独改一个会让手指和飞字脱节。 */
  .dk {
    position: absolute; left: 50%; top: 50%;
    transform: translate(-50%, -50%); animation: ktLift 6s infinite;
  }
  .dk .sub {
    position: absolute; font-size: 0.5rem; color: var(--dim);
    width: auto; height: auto; background: none; border: 0; box-shadow: none;
  }
  /* 角标位置与真键帽一致：上滑在右上、下滑在左下（Keyboard.svelte 同款对角摆放） */
  .dk .sub.up { top: 3px; right: 4px; animation: ktSub 6s infinite; }
  .dk .sub.down { bottom: 3px; left: 4px; animation: ktSub 6s infinite -3s; }
  @keyframes ktLift {
    0%,11% { background: var(--key); border-color: var(--key-line); }
    15%,29% { background: var(--accent-soft); border-color: var(--accent); }
    33%,61% { background: var(--key); border-color: var(--key-line); }
    65%,79% { background: var(--accent-soft); border-color: var(--accent); }
    83%,100% { background: var(--key); border-color: var(--key-line); }
  }
  @keyframes ktSub {
    0%,11% { color: var(--dim); }
    17%,29% { color: var(--accent); }
    33%,100% { color: var(--dim); }
  }
  .demo-flick .finger { animation: ktSwipe 6s infinite; }
  /* 手指走一个来回：先从键上向上抽离，再回到键上向下抽离。
     top 百分比相对 .stage 高度（150px），键在 50% 处。 */
  @keyframes ktSwipe {
    0%,5% { left: 50%; top: 50%; opacity: 0; }
    9%,14% { left: 50%; top: 50%; opacity: 1; }
    28% { left: 50%; top: 8%; opacity: 1; }
    35%,50% { left: 50%; top: 4%; opacity: 0; }
    55%,64% { left: 50%; top: 50%; opacity: 1; }
    78% { left: 50%; top: 92%; opacity: 1; }
    85%,100% { left: 50%; top: 96%; opacity: 0; }
  }
  .fly {
    position: absolute; left: 50%; transform: translateX(-50%);
    font-size: 1.5rem; font-weight: 700; line-height: 1;
    color: var(--accent); pointer-events: none;
  }
  .fly.up { animation: ktFlyUp 6s infinite; }
  .fly.down { animation: ktFlyDown 6s infinite; }
  @keyframes ktFlyUp {
    0%,13% { top: 42%; opacity: 0; }
    19% { top: 30%; opacity: 1; }
    29% { top: 8%; opacity: 1; }
    36%,100% { top: 4%; opacity: 0; }
  }
  @keyframes ktFlyDown {
    0%,63% { top: 52%; opacity: 0; }
    69% { top: 64%; opacity: 1; }
    79% { top: 86%; opacity: 1; }
    86%,100% { top: 90%; opacity: 0; }
  }
  .trail {
    position: absolute; left: 50%; transform: translateX(-50%);
    width: 2px; border-radius: 2px;
  }
  .trail.up {
    bottom: 58%;
    background: linear-gradient(180deg, transparent, var(--accent));
    animation: ktTrailUp 6s infinite;
  }
  .trail.down {
    top: 58%;
    background: linear-gradient(0deg, transparent, var(--accent));
    animation: ktTrailDown 6s infinite;
  }
  @keyframes ktTrailUp {
    0%,13% { height: 0; opacity: 0; }
    21% { height: 20px; opacity: 0.5; }
    29% { height: 40px; opacity: 0.5; }
    36%,100% { height: 40px; opacity: 0; }
  }
  @keyframes ktTrailDown {
    0%,63% { height: 0; opacity: 0; }
    71% { height: 20px; opacity: 0.5; }
    79% { height: 40px; opacity: 0.5; }
    86%,100% { height: 40px; opacity: 0; }
  }

  /* 系统开了「减少动态效果」就别动 —— 静态图配文案同样讲得清楚 */
  @media (prefers-reduced-motion: reduce) {
    .stage *, .stage { animation: none !important; }
    .letters { opacity: 0; }
  }
</style>
