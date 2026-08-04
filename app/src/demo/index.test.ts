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

test("空闲不掉线：握手超时定时器没有变成孤儿", async () => {
  // 回归 2026-08-04：DemoSocket 曾在 send() 的调用栈里同步回 HELLO_ACK，于是
  // established 的 clearHsTimer() 跑在 Connection 装上 hsTimer 之前——那个 5 秒
  // kill 定时器没人清，到点 close()，掉线→重连→再来一遍，周期约 8 秒。
  //
  // 这条必须端到端跑：单看 DemoSocket 或单看 Connection 都是对的，错只发生在
  // 两者拼起来的时序上。6 秒足够越过 5 秒的握手超时（真出 bug 时第一次掉线在
  // 第 5 秒），比跑满一个 8 秒周期省一半时间。
  const { conn } = createDemoConnection("ws://demo.invalid");
  await new Promise((r) => setTimeout(r, 20));
  expect(conn.status).toBe("online");
  await new Promise((r) => setTimeout(r, 6000));
  expect(conn.status, "空闲 6 秒后自己断了").toBe("online");
  conn.dispose();
}, 15000);

test("rpc 能通：fs.tree 拿到演示根的子节点", async () => {
  const { conn } = createDemoConnection("ws://demo.invalid");
  await new Promise((r) => setTimeout(r, 20));
  const r = (await conn.rpc("fs.tree", { path: "/home/demo/project" })) as { nodes: Array<{ name: string }> };
  expect(r.nodes.map((n) => n.name)).toContain("src");
  conn.dispose();
});
