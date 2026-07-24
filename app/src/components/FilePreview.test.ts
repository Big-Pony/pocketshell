import { render, waitFor } from "@testing-library/svelte";
import { describe, it, expect, vi } from "vitest";
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
