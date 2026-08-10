// app/src/demo/rpc.test.ts
import { test, expect } from "vitest";
import { DemoAgent } from "./agent";
import { DEMO_ROOT } from "./fs";
import type { ServerMsg } from "../lib/net/protocol";

function rpcHarness() {
  const out: ServerMsg[] = [];
  const agent = new DemoAgent({ push: (m) => out.push(m) });
  let id = 0;
  return {
    agent,
    /** 发一次 rpc，返回它的 response 帧。 */
    call(method: string, params?: unknown) {
      const rid = String(++id);
      agent.handle({ type: "rpc", id: rid, method, params });
      const r = out.find((m) => m.type === "response" && m.id === rid);
      if (!r) throw new Error(`no response for ${method}`);
      return r as Extract<ServerMsg, { type: "response" }>;
    },
  };
}

test("fs.tree 回惰性单层结构，字段名与 agent 侧一致", () => {
  const h = rpcHarness();
  const r = h.call("fs.tree", { path: DEMO_ROOT });
  expect(r.ok).toBe(true);
  const result = (r as { ok: true; result: { path: string; nodes: Array<{ name: string; type: string }> } }).result;
  expect(result.path).toBe(DEMO_ROOT);
  expect(result.nodes.some((n) => n.name === "src" && n.type === "dir")).toBe(true);
});

test("fs.read 回 content + lang + mtime", () => {
  const h = rpcHarness();
  const r = h.call("fs.read", { path: `${DEMO_ROOT}/src/auth.ts` });
  const result = (r as { ok: true; result: { content: string; lang: string; mtime: number } }).result;
  expect(result.lang).toBe("typescript");
  expect(result.content).toContain("checkSession");
  expect(typeof result.mtime).toBe("number");
});

test("fs.read 读不存在的路径回 ok:false 而不是抛", () => {
  const h = rpcHarness();
  const r = h.call("fs.read", { path: `${DEMO_ROOT}/nope.txt` });
  expect(r.ok).toBe(false);
});

test("fs.diff 回 hunks，kind 只取 add/del/ctx 三种", () => {
  const h = rpcHarness();
  const r = h.call("fs.diff", { path: `${DEMO_ROOT}/src/auth.ts` });
  const { hunks } = (r as { ok: true; result: { hunks: Array<{ header: string; lines: Array<{ kind: string; text: string }> }> } }).result;
  expect(hunks.length).toBeGreaterThan(0);
  expect(hunks[0].lines.every((l) => ["add", "del", "ctx"].includes(l.kind))).toBe(true);
});

test("git.status 回 files，status 是单字母", () => {
  const h = rpcHarness();
  const r = h.call("git.status", { cwd: DEMO_ROOT });
  const { files } = (r as { ok: true; result: { files: Array<{ path: string; status: string }> } }).result;
  expect(files.length).toBeGreaterThan(0);
  expect(files.every((f) => ["M", "A", "D", "?"].includes(f.status))).toBe(true);
});

test("git.branches 回 current + branches，且 current 在 branches 里", () => {
  const h = rpcHarness();
  const r = h.call("git.branches", { cwd: DEMO_ROOT });
  const { current, branches } = (r as { ok: true; result: { current: string; branches: string[] } }).result;
  expect(branches).toContain(current);
});

test("git.log 回 commits，每条带 hash/msg/author/when/files", () => {
  const h = rpcHarness();
  const r = h.call("git.log", { cwd: DEMO_ROOT, limit: 20 });
  const { commits } = (r as { ok: true; result: { commits: Array<Record<string, unknown>> } }).result;
  expect(commits.length).toBeGreaterThan(0);
  for (const c of commits) {
    expect(c).toHaveProperty("hash");
    expect(c).toHaveProperty("msg");
    expect(c).toHaveProperty("author");
    expect(c).toHaveProperty("when");
    expect(Array.isArray(c.files)).toBe(true);
  }
});

test("preview.mint 恒回 token 'demo'（配合演示包里的静态 fixture）", () => {
  const h = rpcHarness();
  const r = h.call("preview.mint", { base: DEMO_ROOT });
  expect((r as { ok: true; result: { token: string } }).result.token).toBe("demo");
});

test("hints.list 回 items，非空（否则联想面板是空的）", () => {
  const h = rpcHarness();
  const r = h.call("hints.list");
  const { items } = (r as { ok: true; result: { items: Array<{ id: string; text: string }> } }).result;
  expect(items.length).toBeGreaterThan(0);
  expect(items.every((i) => typeof i.id === "string" && typeof i.text === "string")).toBe(true);
});

test("term.paneInfo 回三个字段（Terminal 组件按它判 alt-screen）", () => {
  const h = rpcHarness();
  const r = h.call("term.paneInfo", { session: "claude-refactor" });
  const info = (r as { ok: true; result: { currentCommand: string; alternateOn: boolean; isShell: boolean } }).result;
  expect(typeof info.alternateOn).toBe("boolean");
  expect(typeof info.isShell).toBe("boolean");
});

test("term.history 回 {data, seq}，data 是 base64", () => {
  const h = rpcHarness();
  const r = h.call("term.history", { session: "claude-refactor" });
  const { data, seq } = (r as { ok: true; result: { data: string; seq: number } }).result;
  expect(typeof seq).toBe("number");
  expect(() => atob(data)).not.toThrow();
});

test("terminal.pwd 回演示根", () => {
  const h = rpcHarness();
  const r = h.call("terminal.pwd", { session: "claude-refactor" });
  expect((r as { ok: true; result: { pwd: string } }).result.pwd).toBe(DEMO_ROOT);
});

test("agent.info 回 instanceName: null", () => {
  const h = rpcHarness();
  const r = h.call("agent.info");
  expect((r as { ok: true; result: { instanceName: string | null } }).result.instanceName).toBeNull();
});

test.each([
  "update.check", "update.apply", "notify.getConfig", "notify.setConfig",
  "notify.wire", "notify.unwire", "notify.testWebhook", "notify.subscribeWebPush",
  "notify.unsubscribeWebPush", "notify.getVapidPublicKey", "notify.testPush", "context.wire", "context.unwire",
  "diag.report", "fs.write", "fs.op", "fs.uploadCheck", "fs.resolveName",
  "fs.uploadChunk", "fs.downloadChunk", "fs.archive", "term.capture", "term.redraw",
])("写操作与不支持的 method 回结构化 error 而不是静默丢：%s", (method) => {
  const h = rpcHarness();
  const r = h.call(method);
  // 要么明确成功（如 term.redraw 这类无副作用的），要么明确失败——
  // 但绝不能没有 response，那会让前端挂着直到 rpc 超时。
  expect(typeof r.ok).toBe("boolean");
  if (!r.ok) expect((r as { ok: false; error: { code: string } }).error.code).toBeTruthy();
});

test("完全没见过的 method 也必有 response（前端不会挂到超时）", () => {
  const h = rpcHarness();
  const r = h.call("totally.unknown.method");
  expect(r.ok).toBe(false);
});

test("listSnippets 的标签跟随 locale 切换（惰性求值守卫）", async () => {
  const { locale } = await import("svelte-i18n");
  const grab = () => {
    const out: ServerMsg[] = [];
    const agent = new DemoAgent({ push: (m) => out.push(m) });
    agent.handle({ type: "listSnippets" });
    const msg = out.find((m) => m.type === "snippets");
    return (msg as Extract<ServerMsg, { type: "snippets" }>).items.map((i) => i.label);
  };
  const zhLabels = grab();
  locale.set("en");
  const enLabels = grab();
  locale.set("zh"); // 复位
  expect(zhLabels).toContain("派活给 Claude");
  expect(enLabels).toContain("Ask Claude");
});

test("pushSnippets 主动推全量列表（切语言后刷新面板靠它）", async () => {
  // 回归守卫：SnippetPanel 只在挂载时 listSnippets 一次，之后把 items 存在自己
  // 的 state 里。切语言只让 demoSnippets() 的**下一次**求值变英文，已经推过去的
  // 那份不会自己更新——浏览器实测过：切成中文后面板仍显示 "Ask Claude"。
  // 修法是对齐真后端语义（server.ts:394）主动重推，此用例锁住那条通路存在。
  const { locale } = await import("svelte-i18n");
  const out: ServerMsg[] = [];
  const agent = new DemoAgent({ push: (m) => out.push(m) });
  agent.handle({ type: "listSnippets" }); // 首拉（zh）
  locale.set("en");
  agent.pushSnippets();                   // 切语言后重推
  locale.set("zh");                       // 复位
  const pushes = out.filter((m) => m.type === "snippets") as Extract<ServerMsg, { type: "snippets" }>[];
  expect(pushes).toHaveLength(2);
  expect(pushes[0].items.map((i) => i.label)).toContain("派活给 Claude");
  expect(pushes[1].items.map((i) => i.label)).toContain("Ask Claude");
});
