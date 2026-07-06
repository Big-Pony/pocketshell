// Sample component test — "async + side-effect" style.
// Shows how to inject a mocked Connection (only .rpc is used), drive the
// mount-time load, and assert on the number/shape of rpc calls. This one is a
// regression guard for CR fix #2: FileTree must load the root exactly once, so a
// failing fs.tree can't re-trigger the mount $effect into an rpc storm.
import { test, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
import FileTree from "./FileTree.svelte";

beforeEach(() => localStorage.clear()); // default project root → "/"

const tick = () => new Promise((r) => setTimeout(r, 0));

test("loads the root exactly once even when fs.tree keeps failing (no retry storm)", async () => {
  const rpc = vi.fn().mockRejectedValue(Object.assign(new Error("boom"), { code: "rpc_error" }));
  const conn = { rpc } as any;

  render(FileTree, { props: { conn, onOpenFile: vi.fn(), onCd: vi.fn() } });

  await vi.waitFor(() => expect(rpc).toHaveBeenCalled());
  // Give any (buggy) re-triggered effect several turns to fire before asserting.
  await tick(); await tick();

  expect(rpc).toHaveBeenCalledTimes(1);
  expect(rpc).toHaveBeenCalledWith("fs.tree", { path: "/" });
});

test("dir menu exposes 上传文件 and 下载; file menu exposes 下载", async () => {
  const rpc = vi.fn().mockResolvedValue({
    path: "/", nodes: [{ name: "src", type: "dir", hasChildren: true }, { name: "readme.md", type: "file" }],
  });
  const { findByText, getAllByLabelText, queryByText } = render(FileTree, {
    props: { conn: { rpc } as any, onOpenFile: vi.fn(), onCd: vi.fn() },
  });
  await findByText("src");
  // open the dir row's ⋯ menu (first "更多")
  await fireEvent.click(getAllByLabelText("更多")[0]);
  expect(await findByText("上传文件")).toBeInTheDocument();
  expect(await findByText("下载")).toBeInTheDocument();
});

test("renders the loaded root row and its children", async () => {
  const rpc = vi.fn().mockResolvedValue({
    path: "/", nodes: [{ name: "src", type: "dir", hasChildren: true }, { name: "readme.md", type: "file" }],
  });
  const conn = { rpc } as any;

  const { findByText } = render(FileTree, { props: { conn, onOpenFile: vi.fn(), onCd: vi.fn() } });

  expect(await findByText("src")).toBeInTheDocument();
  expect(await findByText("readme.md")).toBeInTheDocument();
});
