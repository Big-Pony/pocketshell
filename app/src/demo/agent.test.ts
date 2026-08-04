// app/src/demo/agent.test.ts
import { test, expect } from "vitest";
import { DemoAgent, DEMO_SESSIONS } from "./agent";
import type { ServerMsg } from "../lib/net/protocol";

/** 收集 agent 推出的所有帧，便于断言。 */
function harness() {
  const out: ServerMsg[] = [];
  const timers: Array<{ id: number; fn: () => void; ms: number } | null> = [];
  const sched = {
    setTimeout: (fn: () => void, ms: number) => { timers.push({ id: timers.length, fn, ms }); return timers.length - 1; },
    clearTimeout: (id: number) => { timers[id] = null; },
  };
  const agent = new DemoAgent({ push: (m) => out.push(m), scheduler: sched });
  return {
    agent,
    out,
    /** 跑一轮当前排期的定时器（新排的进下一轮）。 */
    tick: () => { const cur = timers.filter(Boolean) as Array<{ fn: () => void }>; timers.length = 0; cur.forEach((t) => t.fn()); },
    only: <T extends ServerMsg["type"]>(type: T) => out.filter((m) => m.type === type) as Extract<ServerMsg, { type: T }>[],
  };
}

const decode = (b64: string) => new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));

test("listSessions 回三个会话，状态对应官网首屏叙事", () => {
  const h = harness();
  h.agent.handle({ type: "listSessions" });
  const [msg] = h.only("sessions");
  expect(msg.sessions.map((s) => s.name)).toEqual(["claude-refactor", "kimi-docs", "build-server"]);
  expect(msg.sessions.map((s) => s.state)).toEqual(["run", "wait", "idle"]);
});

test("DEMO_SESSIONS 的 createdAt 是固定值，不随时间漂移", () => {
  // 每次刷新演示站，会话「创建于」应当一致；用 Date.now() 会让截图与测试都不稳。
  expect(DEMO_SESSIONS.every((s) => Number.isFinite(s.createdAt) && s.createdAt > 0)).toBe(true);
  const a = new DemoAgent({ push: () => {} });
  const b = new DemoAgent({ push: () => {} });
  expect(a.snapshotSessions()[0].createdAt).toBe(b.snapshotSessions()[0].createdAt);
});

test("ping 回 pong", () => {
  const h = harness();
  h.agent.handle({ type: "ping" });
  expect(h.only("pong").length).toBe(1);
});

test("emitOutput 的 seq 从 1 起严格递增，data 是 base64", () => {
  const h = harness();
  h.agent.handle({ type: "attach", sessionId: "claude-refactor" });
  h.agent.emitOutput("claude-refactor", "hello");
  h.agent.emitOutput("claude-refactor", "world");
  const outs = h.only("output");
  expect(outs.map((o) => o.seq)).toEqual([1, 2]);
  expect(decode(outs[0].data)).toBe("hello");
  expect(decode(outs[1].data)).toBe("world");
});

test("seq 是全局单调的：跨会话也不复用同一个号", () => {
  // 与真 agent 的 per-session seq 不同——演示只要「单调」这一个性质成立，
  // 补齐逻辑就正确，而全局计数器更难写错。这里把它钉成契约。
  const h = harness();
  h.agent.handle({ type: "attach", sessionId: "claude-refactor" });
  h.agent.handle({ type: "attach", sessionId: "kimi-docs" });
  h.agent.emitOutput("claude-refactor", "a");
  h.agent.emitOutput("kimi-docs", "b");
  expect(h.only("output").map((o) => o.seq)).toEqual([1, 2]);
});

test("未 attach 的会话不推 output（对齐真 agent 的订阅语义）", () => {
  const h = harness();
  h.agent.emitOutput("claude-refactor", "nobody listening");
  expect(h.only("output")).toEqual([]);
});

test("detach 之后不再收到该会话的 output", () => {
  const h = harness();
  h.agent.handle({ type: "attach", sessionId: "claude-refactor" });
  h.agent.handle({ type: "detach", sessionId: "claude-refactor" });
  h.agent.emitOutput("claude-refactor", "x");
  expect(h.only("output")).toEqual([]);
});

test("input 回显：敲进去的字节原样回流（终端才看得见自己打的字）", () => {
  const h = harness();
  h.agent.handle({ type: "attach", sessionId: "claude-refactor" });
  h.agent.handle({ type: "input", sessionId: "claude-refactor", data: btoa("l") });
  expect(decode(h.only("output")[0].data)).toBe("l");
});

test("回车触发命令执行：ls 有输出且以提示符收尾", () => {
  const h = harness();
  h.agent.handle({ type: "attach", sessionId: "claude-refactor" });
  for (const ch of "ls\r") h.agent.handle({ type: "input", sessionId: "claude-refactor", data: btoa(ch) });
  h.tick();
  const all = h.only("output").map((o) => decode(o.data)).join("");
  expect(all).toContain("src");
  expect(all.trimEnd().endsWith("$")).toBe(true);
});

test("newSession 追加会话并广播 sessions", () => {
  const h = harness();
  h.agent.handle({ type: "newSession", name: "scratch", kind: "tmux" });
  const last = h.only("sessions").at(-1)!;
  expect(last.sessions.map((s) => s.name)).toContain("scratch");
});

test("kill 移除会话并广播", () => {
  const h = harness();
  h.agent.handle({ type: "kill", sessionId: "build-server" });
  const last = h.only("sessions").at(-1)!;
  expect(last.sessions.map((s) => s.name)).not.toContain("build-server");
});

test("renameSession 改名后 sessions 反映新名字", () => {
  const h = harness();
  h.agent.handle({ type: "renameSession", sessionId: "kimi-docs", name: "kimi-notes" });
  const last = h.only("sessions").at(-1)!;
  expect(last.sessions.map((s) => s.name)).toContain("kimi-notes");
  expect(last.sessions.map((s) => s.name)).not.toContain("kimi-docs");
});
