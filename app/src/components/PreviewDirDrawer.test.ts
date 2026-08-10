import { render, waitFor, fireEvent } from "@testing-library/svelte";
import { describe, it, expect, vi } from "vitest";
import PreviewDirDrawer from "./PreviewDirDrawer.svelte";

function connStub(tree: Record<string, any[]>, fail = false) {
  return {
    rpc: vi.fn(async (m: string, p: any) => {
      if (m !== "fs.tree") return {};
      if (fail) throw new Error("boom");
      return { path: p.path, nodes: tree[p.path] ?? [] };
    }),
  } as any;
}

describe("PreviewDirDrawer", () => {
  const base = "/proj";

  it("lists the root directory's entries and highlights the current file", async () => {
    const conn = connStub({
      "/proj": [
        { name: "sub", type: "dir", hasChildren: true },
        { name: "a.ts", type: "file" },
      ],
    });
    const { container, getByText } = render(PreviewDirDrawer, {
      props: { conn, rootDir: base, currentPath: "/proj/a.ts", open: true, onSelect: () => {}, onClose: () => {} },
    });
    await waitFor(() => getByText("a.ts"));
    getByText("sub");
    const cur = container.querySelector(".row.cur");
    expect(cur?.textContent).toContain("a.ts");
  });

  it("lazily expands a subdirectory on tap", async () => {
    const conn = connStub({
      "/proj": [{ name: "sub", type: "dir", hasChildren: true }],
      "/proj/sub": [{ name: "b.ts", type: "file" }],
    });
    const { getByText } = render(PreviewDirDrawer, {
      props: { conn, rootDir: base, currentPath: "/proj/x.ts", open: true, onSelect: () => {}, onClose: () => {} },
    });
    await waitFor(() => getByText("sub"));
    await fireEvent.click(getByText("sub"));
    await waitFor(() => getByText("b.ts"));
  });

  it("calls onSelect with the absolute path when a file is tapped", async () => {
    const onSelect = vi.fn();
    const conn = connStub({ "/proj": [{ name: "a.ts", type: "file" }] });
    const { getByText } = render(PreviewDirDrawer, {
      props: { conn, rootDir: base, currentPath: "/proj/x.ts", open: true, onSelect, onClose: () => {} },
    });
    await waitFor(() => getByText("a.ts"));
    await fireEvent.click(getByText("a.ts"));
    expect(onSelect).toHaveBeenCalledWith("/proj/a.ts");
  });

  it("shows a notice when fs.tree fails", async () => {
    const conn = connStub({}, true);
    const { getByText } = render(PreviewDirDrawer, {
      props: { conn, rootDir: base, currentPath: "/proj/x.ts", open: true, onSelect: () => {}, onClose: () => {} },
    });
    await waitFor(() => getByText("目录加载失败"));
  });
});

describe("PreviewDirDrawer 加载态", () => {
  // 14 期需求 5：fs.tree 回来之前 rows 恒为空，与「目录确实是空的」共用
  // 一个条件——加载中给出的是肯定的错误结论。
  it("加载中不显示「空目录」，加载完才显示", async () => {
    let release: ((v: any) => void) | null = null;
    const conn = {
      rpc: vi.fn(() => new Promise((r) => { release = r; })),
    } as any;
    const { container } = render(PreviewDirDrawer, {
      props: { conn, rootDir: "/proj", currentPath: "", open: true, onSelect: () => {}, onClose: () => {} },
    });
    expect(container.querySelector(".dempty")).toBeNull();
    release!({ path: "/proj", nodes: [] });
    await waitFor(() => expect(container.querySelector(".dempty")).toBeTruthy());
  });
});
