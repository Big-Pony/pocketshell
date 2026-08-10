import { render, waitFor } from "@testing-library/svelte";
import { describe, it, expect, vi, beforeEach } from "vitest";
import FilePreview from "./FilePreview.svelte";

function connStub(overrides: Record<string, any> = {}) {
  return {
    agentUrl: "ws://localhost:8722",
    rpc: vi.fn(async (m: string) => {
      if (m === "preview.mint") return { token: "TOK" };
      return {};
    }),
    ...overrides,
  } as any;
}

describe("FilePreview image", () => {
  it("renders an <img> pointing at the /preview token route", async () => {
    const conn = connStub();
    const { container } = render(FilePreview, {
      props: {
        conn, path: "/root/proj/a.png", mode: "code", active: true,
        base: "/root/proj", onToast: () => {},
      },
    });
    await waitFor(() => {
      const img = container.querySelector("img");
      expect(img).toBeTruthy();
      expect(img!.getAttribute("src")).toContain("/preview/TOK/a.png");
    });
  });
});

describe("FilePreview markdown view toggle", () => {
  it("defaults to render and switches via the segmented control", async () => {
    const conn = connStub({
      rpc: vi.fn(async (m: string) => {
        if (m === "preview.mint") return { token: "TOK" };
        if (m === "fs.read") return { content: "# Hi", lang: "markdown", mtime: 1 };
        return {};
      }),
    });
    const { container, getByText } = render(FilePreview, {
      props: {
        conn, path: "/root/proj/a.md", mode: "code", active: true,
        base: "/root/proj", onToast: () => {},
      },
    });
    // default view is render
    await waitFor(() =>
      expect(container.querySelector(".pv-content")?.getAttribute("data-view")).toBe("render"));
    // clicking 源码 switches to source
    getByText("源码").click();
    await waitFor(() =>
      expect(container.querySelector(".pv-content")?.getAttribute("data-view")).toBe("source"));
  });
});

import { fireEvent } from "@testing-library/svelte";

describe("FilePreview directory drawer", () => {
  function codeConn() {
    return connStub({
      rpc: vi.fn(async (m: string, p: any) => {
        if (m === "preview.mint") return { token: "TOK" };
        if (m === "fs.read") return { content: "const x = 1", lang: "typescript", mtime: 1 };
        if (m === "fs.tree") return { path: p.path, nodes: [{ name: "a.ts", type: "file" }, { name: "b.ts", type: "file" }] };
        return {};
      }),
    });
  }

  it("shows the 目录 button only after entering fullscreen", async () => {
    const conn = codeConn();
    const { queryByText, getByLabelText, findByRole } = render(FilePreview, {
      props: { conn, path: "/proj/a.ts", mode: "code", active: true, base: "/proj", onToast: () => {} },
    });
    expect(queryByText("目录")).toBeNull();          // not fullscreen yet
    await fireEvent.click(getByLabelText("全屏"));    // ⛶ enter fullscreen
    // The drawer (mounted alongside the button once fullscreen) also carries a
    // "目录" title, so disambiguate via role: the button, not the drawer heading.
    await findByRole("button", { name: "目录" });
  });

  it("navigates in place: tapping a drawer file fires onNavigate", async () => {
    const conn = codeConn();
    const onNavigate = vi.fn();
    const { getByLabelText, findByRole, findByText } = render(FilePreview, {
      props: { conn, path: "/proj/a.ts", mode: "code", active: true, base: "/proj", onToast: () => {}, onNavigate },
    });
    await fireEvent.click(getByLabelText("全屏"));
    await fireEvent.click(await findByRole("button", { name: "目录" }));  // open drawer
    await fireEvent.click(await findByText("b.ts"));  // pick sibling
    expect(onNavigate).toHaveBeenCalledWith("/proj/b.ts");
  });
});

// ---------------------------------------------------------------------------
// 13 期需求 1b：底部留白，让用户能把文件末尾的内容往上拖。
// .pv-content 是源码/Markdown/diff 共用的滚动容器，留白加一处即可。
// ---------------------------------------------------------------------------
describe("FilePreview 底部留白", () => {
  it("源码视图挂 pad-bot", async () => {
    const conn = connStub({
      rpc: vi.fn(async (m: string) => {
        if (m === "preview.mint") return { token: "TOK" };
        if (m === "fs.read") return { content: "const a = 1", lang: "javascript", mtime: 1 };
        return {};
      }),
    });
    const { container } = render(FilePreview, {
      props: { conn, path: "/p/a.js", mode: "code", active: true, base: "/p", onToast: () => {} },
    });
    await waitFor(() => {
      expect(container.querySelector(".pv-content.pad-bot")).toBeTruthy();
    });
  });

  it("图片视图不挂 pad-bot（图片下面挂半屏空白没有意义）", async () => {
    const conn = connStub();
    const { container } = render(FilePreview, {
      props: { conn, path: "/p/a.png", mode: "code", active: true, base: "/p", onToast: () => {} },
    });
    await waitFor(() => expect(container.querySelector("img")).toBeTruthy());
    expect(container.querySelector(".pv-content.pad-bot")).toBeNull();
  });

  it("代码文件的 diff 视图挂 pad-bot", async () => {
    const conn = connStub({
      rpc: vi.fn(async (m: string) => {
        if (m === "fs.diff") return { hunks: [{ header: "@@ -1 +1 @@", lines: [] }] };
        return {};
      }),
    });
    const { container } = render(FilePreview, {
      props: { conn, path: "/p/a.js", mode: "diff", active: true, base: "/p", onToast: () => {} },
    });
    await waitFor(() => {
      expect(container.querySelector(".pv-content.pad-bot")).toBeTruthy();
    });
  });
});

// ---------------------------------------------------------------------------
// 14 期需求 1：顶栏尺寸按钮 + 底部弹层。
// 顶栏在 390px 宽下已挤着 预览/源码、目录、退出全屏、⟳，所以收成一个按钮，
// 点开才展示三档（用户明确要求的形态）。
// ---------------------------------------------------------------------------
describe("HTML 预览尺寸切换", () => {
  // 档位持久化在 localStorage，同文件里的前一条用例会把它写脏，
  // 每条都从干净状态起（默认手机档）。
  beforeEach(() => localStorage.clear());

  // html kind 走 fs.read + preview.mint 两条 RPC，默认 stub 的 fs.read 返回 {}
  // 会让 highlightTo 拿到 undefined，故这里给全。
  const htmlConn = () =>
    connStub({
      rpc: vi.fn(async (m: string) => {
        if (m === "preview.mint") return { token: "TOK" };
        if (m === "fs.read") return { content: "<h1>hi</h1>", lang: "html", mtime: 1 };
        return {};
      }),
    });

  const htmlProps = () => ({
    conn: htmlConn(),
    path: "/proj/page.html",
    mode: "code" as const,
    active: true,
    base: "/proj",
    onToast: () => {},
  });

  it("HTML 渲染态显示尺寸按钮，带当前档位名", async () => {
    const { findByText } = render(FilePreview, { props: htmlProps() });
    expect(await findByText(/手机/)).toBeTruthy();
  });

  it("代码文件不显示尺寸按钮", async () => {
    const conn = connStub({
      rpc: vi.fn(async (m: string) => {
        if (m === "preview.mint") return { token: "TOK" };
        if (m === "fs.read") return { content: "const a = 1", lang: "javascript", mtime: 1 };
        return {};
      }),
    });
    const { queryByText, container } = render(FilePreview, {
      props: { ...htmlProps(), conn, path: "/proj/a.ts" },
    });
    await waitFor(() => expect(container.querySelector(".pv-content")).toBeTruthy());
    expect(queryByText(/手机|平板|桌面/)).toBeNull();
  });

  it("点按钮弹出三档，选桌面后按钮文案跟着变", async () => {
    const { findByText, getByText, container } = render(FilePreview, { props: htmlProps() });
    await fireEvent.click(await findByText(/手机/));
    await waitFor(() => expect(container.querySelector(".wpick")).toBeTruthy());
    // 弹层里每行显示 档位名 · 宽度px
    expect(getByText(/桌面/)).toBeTruthy();
    expect(container.querySelector(".wpick")!.textContent).toContain("1280px");
    await fireEvent.click(getByText(/桌面/));
    await waitFor(() => expect(container.querySelector(".wpick")).toBeNull());
    expect(await findByText(/桌面/)).toBeTruthy();
  });

  it("选择持久化到 settings", async () => {
    const { findByText, getByText } = render(FilePreview, { props: htmlProps() });
    await fireEvent.click(await findByText(/手机/));
    await fireEvent.click(getByText(/平板/));
    await waitFor(() => {
      const s = JSON.parse(localStorage.getItem("ps.settings") || "{}");
      expect(s.htmlPreviewWidth).toBe("tablet");
    });
  });

  it("源码态不显示尺寸按钮（只在渲染态有意义）", async () => {
    const { findByText, queryByText } = render(FilePreview, { props: htmlProps() });
    await fireEvent.click(await findByText("源码"));
    await waitFor(() => expect(queryByText(/手机|平板|桌面/)).toBeNull());
  });
});
