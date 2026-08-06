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
      <!-- 手指按住 h 键上滑，角标 | 跟着飞出并留一条轨迹 -->
      <div class="stage demo-flick" aria-hidden="true">
        <div class="trail"></div>
        <div class="fly">|</div>
        <div class="dk"><span class="sub">|</span>h</div>
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

  /* flick：手指上滑，符号跟着飞出 */
  .dk { position: absolute; left: 50%; bottom: 16px; transform: translateX(-50%); animation: ktLift 3s infinite; }
  .dk .sub {
    position: absolute; top: 3px; right: 4px; font-size: 0.5rem; color: var(--dim);
    width: auto; height: auto; background: none; border: 0; box-shadow: none;
    animation: ktSub 3s infinite;
  }
  @keyframes ktLift {
    0%,22% { background: var(--key); border-color: var(--key-line); }
    30%,58% { background: var(--accent-soft); border-color: var(--accent); }
    66%,100% { background: var(--key); border-color: var(--key-line); }
  }
  @keyframes ktSub {
    0%,22% { color: var(--dim); }
    34%,58% { color: var(--accent); }
    66%,100% { color: var(--dim); }
  }
  .demo-flick .finger { transform: translateX(-50%); animation: ktSwipe 3s infinite; }
  @keyframes ktSwipe {
    0%,10% { left: 50%; bottom: 22px; opacity: 0; }
    18% { left: 50%; bottom: 22px; opacity: 1; }
    28% { left: 50%; bottom: 26px; opacity: 1; }
    56% { left: 50%; bottom: 104px; opacity: 1; }
    70%,100% { left: 50%; bottom: 112px; opacity: 0; }
  }
  .fly {
    position: absolute; left: 50%; transform: translateX(-50%);
    font-size: 1.5rem; font-weight: 700; line-height: 1;
    color: var(--accent); pointer-events: none; animation: ktFly 3s infinite;
  }
  @keyframes ktFly {
    0%,26% { bottom: 44px; opacity: 0; }
    38% { bottom: 58px; opacity: 1; }
    58% { bottom: 108px; opacity: 1; }
    72%,100% { bottom: 118px; opacity: 0; }
  }
  .trail {
    position: absolute; left: 50%; transform: translateX(-50%);
    width: 2px; border-radius: 2px; bottom: 62px;
    background: linear-gradient(180deg, transparent, var(--accent));
    animation: ktTrail 3s infinite;
  }
  @keyframes ktTrail {
    0%,26% { height: 0; opacity: 0; }
    42% { height: 26px; opacity: 0.5; }
    58% { height: 52px; opacity: 0.5; }
    72%,100% { height: 52px; opacity: 0; }
  }

  /* 系统开了「减少动态效果」就别动 —— 静态图配文案同样讲得清楚 */
  @media (prefers-reduced-motion: reduce) {
    .stage *, .stage { animation: none !important; }
    .letters { opacity: 0; }
  }
</style>
