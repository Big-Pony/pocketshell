import { test, expect } from "bun:test";
import { parse, compressHistory, RPC_TABLE } from "./rpc-router";

test("parse.gitReview 解析 worktree 三档", () => {
  expect(parse.gitReview({ cwd: "/p", scope: { kind: "worktree", stage: "staged" } }))
    .toEqual({ cwd: "/p", scope: { kind: "worktree", stage: "staged" } });
});

test("parse.gitReview 缺 stage 时默认 all", () => {
  const r = parse.gitReview({ cwd: "/p", scope: { kind: "worktree" } });
  expect(r.scope).toEqual({ kind: "worktree", stage: "all" });
});

test("parse.gitReview 解析 commit 与 range", () => {
  expect(parse.gitReview({ cwd: "/p", scope: { kind: "commit", hash: "abc" } }).scope)
    .toEqual({ kind: "commit", hash: "abc" });
  expect(parse.gitReview({ cwd: "/p", scope: { kind: "range", base: "main" } }).scope)
    .toEqual({ kind: "range", base: "main" });
});

test("parse.gitReview range 缺 base 时不产出 'undefined' 字符串", () => {
  // String(undefined) === "undefined" 会让后端去 diff 一个叫 undefined 的
  // revision，用户看到的是莫名其妙的 bad_revision 而不是自动推断的基线。
  const r = parse.gitReview({ cwd: "/p", scope: { kind: "range" } });
  expect(r.scope).toEqual({ kind: "range" });
  expect((r.scope as { base?: string }).base).toBeUndefined();
});

test("parse.gitReview 对未知 kind 回落到 worktree/all（不 throw）", () => {
  // 线上老客户端 / 手工构造的请求不该让 agent 500，回落到最安全的默认范围
  const r = parse.gitReview({ cwd: "/p", scope: { kind: "bogus" } });
  expect(r.scope).toEqual({ kind: "worktree", stage: "all" });
});

test("term.history 压缩后带 enc=gzip，且解压回原字节", () => {
  const raw = Buffer.from("A".repeat(10000));
  const h = { data: raw.toString("base64"), seq: 7 };
  const out = compressHistory(h);
  expect(out.enc).toBe("gzip");
  expect(out.seq).toBe(7);
  const back = Bun.gunzipSync(Buffer.from(out.data, "base64"));
  expect(Buffer.from(back).toString()).toBe("A".repeat(10000));
});

test("压不小的短载荷原样返回，不带 enc", () => {
  const h = { data: Buffer.from("hi").toString("base64"), seq: 1 };
  expect(compressHistory(h).enc).toBeUndefined();
});

test("parse.termHistory 读 lines，缺省为 undefined（= 全量 scrollback）", () => {
  expect(parse.termHistory({ session: "work", lines: 1000 })).toEqual({ session: "work", lines: 1000 });
  expect(parse.termHistory({ session: "work" }).lines).toBeUndefined();
});

// 14 期需求 4：devicePub 为 null 时此前静默丢弃订阅却照样回 {ok:true}，
// 前端以为订阅成功、然后永远收不到推送且无从排查。正常握手后它不该为 null，
// 但静默失败通道必须堵上——handler 抛错，dispatchRpc 转成 rpc_error 回给前端。
test("notify.subscribeWebPush 在没有设备身份时报错而不是静默成功", () => {
  const ctx = {
    devicePub: null,
    notify: { addSub: () => { throw new Error("不该被调用"); } },
  } as unknown as Parameters<(typeof RPC_TABLE)["notify.subscribeWebPush"]>[0];
  expect(() => RPC_TABLE["notify.subscribeWebPush"](ctx, { subscription: {} }))
    .toThrow("no_device_identity");
});

test("notify.subscribeWebPush 有设备身份时照常写入", () => {
  const seen: unknown[] = [];
  const ctx = {
    devicePub: "PUB",
    notify: { addSub: (k: string, s: unknown) => seen.push([k, s]) },
  } as unknown as Parameters<(typeof RPC_TABLE)["notify.subscribeWebPush"]>[0];
  const out = RPC_TABLE["notify.subscribeWebPush"](ctx, { subscription: { endpoint: "e" } });
  expect(seen).toEqual([["PUB", { endpoint: "e" }]]);
  expect(out).toEqual({ kind: "result", result: { ok: true } });
});
