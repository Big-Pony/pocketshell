<script lang="ts">
  let { src, widthPx = 390, scale = 1 }: {
    src: string;
    /** iframe 的布局宽度。桌面站据此走桌面响应式分支（14 期需求 1）。 */
    widthPx?: number;
    /** 视觉缩放比，由父组件用 scaleFor(widthPx, 可用宽) 算出。恒 ≤ 1。 */
    scale?: number;
  } = $props();

  // 缩放只影响绘制，元素仍按原尺寸参与布局，所以外层要按比例折算，
  // 否则 1280 宽的 iframe 会把容器撑出横向滚动条——正是本需求要消掉的东西。
  const wrapW = $derived(Math.round(widthPx * scale));

  // 高度同理要抵消 scale：transform 把宽高一起缩，宽度缩是我们要的，
  // 高度缩会让可视区只剩容器的 scale 倍（桌面档 ≈30%），页面被拦腰截断。
  // 用 1/scale 放大再被 scale 缩回，净效果是"高度铺满容器、宽度按档位"。
  const frameH = $derived(Math.round(100 / (scale > 0 ? scale : 1)));
</script>

<!-- allow-scripts WITHOUT allow-same-origin: page JS runs in an opaque origin
     and cannot reach the parent window / App identity keys.
     服务端 /preview 路由的响应头 `content-security-policy: sandbox allow-scripts`
     独立施加同一约束——改这里单方面无效，两处都有测试锁死。 -->
<div class="html-wrap" style:width="{wrapW}px">
  <iframe
    class="html-frame"
    title="preview"
    {src}
    sandbox="allow-scripts"
    style:width="{widthPx}px"
    style:height="{frameH}%"
    style:transform="scale({scale})"
    style:transform-origin="top left"
  ></iframe>
</div>

<style>
  /* 容器居中：桌面档缩放后若仍窄于屏幕（大屏），居中比贴左自然。 */
  .html-wrap { height: 100%; margin: 0 auto; overflow: hidden; }
  /* 高度由内联 style 的 frameH（1/scale）给出——CSS 的 height:100% 会连同
     scale 一起缩，桌面档下可视区只剩容器的 ≈30%，页面被拦腰截断。 */
  .html-frame { border: 0; background: #fff; display: block; }
</style>
