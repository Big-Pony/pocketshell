import { render, waitFor } from "@testing-library/svelte";
import { describe, it, expect, vi } from "vitest";
import FilePreview from "./FilePreview.svelte";

function connStub(overrides: Record<string, any> = {}) {
  return {
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
