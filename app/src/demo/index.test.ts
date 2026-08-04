// app/src/demo/index.test.ts
// 端到端：createDemoConnection 出来的 Connection 能真的连上、收到会话列表。
import { test, expect } from "vitest";
import { createDemoConnection } from "./index";

test("工厂产出的 Connection 能走完握手并转 online", async () => {
  const { conn } = createDemoConnection("ws://demo.invalid");
  await new Promise((r) => setTimeout(r, 20)); // 等 queueMicrotask + 握手
  expect(conn.status).toBe("online");
  conn.dispose();
});

test("连上后能收到三个演示会话", async () => {
  const { conn } = createDemoConnection("ws://demo.invalid");
  const got: string[][] = [];
  conn.onSessions((s) => got.push(s.map((x) => x.name)));
  await new Promise((r) => setTimeout(r, 20));
  conn.listSessions();
  await new Promise((r) => setTimeout(r, 10));
  expect(got.at(-1)).toEqual(["claude-refactor", "kimi-docs", "build-server"]);
  conn.dispose();
});

test("rpc 能通：fs.tree 拿到演示根的子节点", async () => {
  const { conn } = createDemoConnection("ws://demo.invalid");
  await new Promise((r) => setTimeout(r, 20));
  const r = (await conn.rpc("fs.tree", { path: "/home/demo/project" })) as { nodes: Array<{ name: string }> };
  expect(r.nodes.map((n) => n.name)).toContain("src");
  conn.dispose();
});
