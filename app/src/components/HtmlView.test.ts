import { render } from "@testing-library/svelte";
import { describe, it, expect } from "vitest";
import HtmlView from "./HtmlView.svelte";

describe("HtmlView", () => {
  it("renders a script-sandboxed iframe without same-origin", () => {
    const { container } = render(HtmlView, { props: { src: "http://agent/preview/T/index.html" } });
    const f = container.querySelector("iframe")!;
    expect(f.getAttribute("src")).toBe("http://agent/preview/T/index.html");
    const sb = f.getAttribute("sandbox") ?? "";
    expect(sb).toContain("allow-scripts");
    expect(sb).not.toContain("allow-same-origin");
  });
});

// 14 期需求 1：宽度与缩放是两个独立旋钮。
// width 决定 iframe 内部页面按多宽布局（桌面站据此走桌面分支），
// scale 只把渲染结果压回屏幕内——**scale 不改变 iframe 内部的视口宽度**，
// 所以两者缺一不可。
describe("HtmlView 宽度与缩放", () => {
  it("默认手机宽度、不缩放", () => {
    const { container } = render(HtmlView, { props: { src: "https://x/y.html" } });
    const f = container.querySelector("iframe") as HTMLIFrameElement;
    expect(f.style.width).toBe("390px");
    expect(f.style.transform === "" || f.style.transform === "scale(1)").toBe(true);
  });

  it("桌面档设 1280px 宽并按传入比例缩放", () => {
    const { container } = render(HtmlView, {
      props: { src: "https://x/y.html", widthPx: 1280, scale: 0.3 },
    });
    const f = container.querySelector("iframe") as HTMLIFrameElement;
    expect(f.style.width).toBe("1280px");
    expect(f.style.transform).toContain("scale(0.3)");
    // 左上角为原点：缩放后内容贴左上，不会在容器里偏移出一块空白
    expect(f.style.transformOrigin).toBe("top left");
  });

  // 缩放只影响视觉，元素仍按原尺寸参与布局，所以外层必须按 scale 折算高度，
  // 否则 1280 宽的 iframe 会把容器撑出横向滚动条（正是要避免的东西）。
  it("外层容器按缩放比折算尺寸", () => {
    const { container } = render(HtmlView, {
      props: { src: "https://x/y.html", widthPx: 1280, scale: 0.5 },
    });
    const wrap = container.querySelector(".html-wrap") as HTMLElement;
    expect(wrap).toBeTruthy();
    expect(wrap.style.width).toBe("640px"); // 1280 * 0.5
  });

  // 既有断言：sandbox 不得放开 allow-same-origin（服务端 CSP 也独立锁着）
  it("sandbox 仍不含 allow-same-origin", () => {
    const { container } = render(HtmlView, {
      props: { src: "https://x/y.html", widthPx: 1280, scale: 0.3 },
    });
    const f = container.querySelector("iframe") as HTMLIFrameElement;
    expect(f.getAttribute("sandbox")).toBe("allow-scripts");
  });
  it("iframe 高度抵消缩放，可视区仍铺满容器", () => {
    const { container } = render(HtmlView, {
      props: { src: "https://x/y.html", widthPx: 1280, scale: 0.5 },
    });
    const f = container.querySelector("iframe") as HTMLIFrameElement;
    expect(f.style.height).toBe("200%"); // 1/0.5
  });
});
