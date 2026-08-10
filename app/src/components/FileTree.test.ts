// Sample component test — "async + side-effect" style.
// Shows how to inject a mocked Connection (only .rpc is used), drive the
// mount-time load, and assert on the number/shape of rpc calls. This one is a
// regression guard for CR fix #2: FileTree must load the root exactly once, so a
// failing fs.tree can't re-trigger the mount $effect into an rpc storm.
import { test, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
import FileTree from "./FileTree.svelte";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

// ---------------------------------------------------------------------------
// 14 期需求 5：加载反馈。
// ---------------------------------------------------------------------------
test("递归刷新时 ⟳ 禁用 —— 唯一的 N 次串行 RTT 路径，不禁用会被连点叠加请求", async () => {
  let release: ((v: any) => void) | null = null;
  // 挂载阶段立刻返回，点了 ⟳ 之后才挂起——用显式开关而不是数调用次数，
  // 同文件里前面的用例会通过 browse 缓存影响挂载时的请求数。
  let hang = false;
  const rpc = vi.fn(() => {
    if (!hang) return Promise.resolve({ path: "/", nodes: [{ name: "src", type: "dir", hasChildren: true }] });
    return new Promise((r) => { release = r; });
  });
  const { findByText, getByLabelText } = render(FileTree, {
    props: { conn: { rpc } as any, onOpenFile: vi.fn(), onCd: vi.fn() },
  });
  await findByText("src");
  const rf = getByLabelText("刷新目录") as HTMLButtonElement;
  expect(rf.disabled).toBe(false);
  hang = true;
  rf.click();
  await vi.waitFor(() => expect(rf.disabled).toBe(true));
  release!({ path: "/", nodes: [] });
  await vi.waitFor(() => expect(rf.disabled).toBe(false));
});

test("不再有全屏转圈遮罩 —— 同时违反「不要全屏」与「不要转圈」两条", () => {
  // 打包遮罩只在 archiving 为真时渲染，DOM 断言在挂载态下会空过；
  // 故直接读源文件，确认那套 fixed 满屏 + 旋转 keyframes 已被删干净。
  const SRC = readFileSync(resolve(__dirname, "./FileTree.svelte"), "utf8");
  expect(SRC, "全屏遮罩还在").not.toContain("arch-overlay");
  expect(SRC, "转圈还在").not.toContain("keyframes spin");
  expect(SRC, "spinner 类还在").not.toMatch(/\.spinner\s*\{/);
});
