// app/src/demo/agent.test.ts
import { test, expect } from "vitest";
import { DemoAgent, DEMO_SESSIONS, REPLAY_CAP } from "./agent";
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

test("题眼：断线期间继续产出，重连后完整补齐、不重不漏", () => {
  const h = harness();
  h.agent.handle({ type: "attach", sessionId: "claude-refactor" });

  h.agent.emitOutput("claude-refactor", "before-1");
  h.agent.emitOutput("claude-refactor", "before-2");
  const seenBeforeDrop = h.only("output").at(-1)!.seq;
  expect(seenBeforeDrop).toBe(2);

  // —— 断线：传输层没了，但 agent 内部照跑 ——
  h.agent.detachTransport();
  h.agent.emitOutput("claude-refactor", "during-1");
  h.agent.emitOutput("claude-refactor", "during-2");
  h.agent.emitOutput("claude-refactor", "during-3");

  // 断线期间一帧都不该推出去
  expect(h.only("output").length).toBe(2);

  // —— 重连：新 socket + attach(lastSeq) ——
  const after: ServerMsg[] = [];
  h.agent.setPush((m) => after.push(m));
  h.agent.handle({ type: "attach", sessionId: "claude-refactor", lastSeq: seenBeforeDrop });

  const replayed = after.filter((m) => m.type === "output") as Extract<ServerMsg, { type: "output" }>[];
  expect(replayed.map((o) => o.seq)).toEqual([3, 4, 5]);            // 不重不漏
  expect(replayed.map((o) => decode(o.data))).toEqual(["during-1", "during-2", "during-3"]);
});

test("补齐是幂等的：同一个 lastSeq 再 attach 一次不会重放两遍", () => {
  const h = harness();
  h.agent.handle({ type: "attach", sessionId: "claude-refactor" });
  h.agent.emitOutput("claude-refactor", "a");
  h.agent.detachTransport();
  h.agent.emitOutput("claude-refactor", "b");

  const after: ServerMsg[] = [];
  h.agent.setPush((m) => after.push(m));
  h.agent.handle({ type: "attach", sessionId: "claude-refactor", lastSeq: 1 });
  h.agent.handle({ type: "attach", sessionId: "claude-refactor", lastSeq: 2 });

  const seqs = (after.filter((m) => m.type === "output") as Extract<ServerMsg, { type: "output" }>[]).map((o) => o.seq);
  expect(seqs).toEqual([2]);
});

test("补齐只吐该会话的帧，不串会话", () => {
  const h = harness();
  h.agent.handle({ type: "attach", sessionId: "claude-refactor" });
  h.agent.handle({ type: "attach", sessionId: "kimi-docs" });
  h.agent.detachTransport();
  h.agent.emitOutput("claude-refactor", "mine");
  h.agent.emitOutput("kimi-docs", "theirs");

  const after: ServerMsg[] = [];
  h.agent.setPush((m) => after.push(m));
  h.agent.handle({ type: "attach", sessionId: "claude-refactor", lastSeq: 0 });

  const outs = after.filter((m) => m.type === "output") as Extract<ServerMsg, { type: "output" }>[];
  expect(outs.map((o) => decode(o.data))).toEqual(["mine"]);
});

test("lastSeq 早于缓冲最老一帧时下发 resync（对齐真 agent 的 gap 语义）", () => {
  const h = harness();
  h.agent.handle({ type: "attach", sessionId: "claude-refactor" });
  h.agent.detachTransport();
  // 塞满并溢出缓冲
  for (let i = 0; i < REPLAY_CAP + 5; i++) h.agent.emitOutput("claude-refactor", `x${i}`);

  const after: ServerMsg[] = [];
  h.agent.setPush((m) => after.push(m));
  h.agent.handle({ type: "attach", sessionId: "claude-refactor", lastSeq: 0 });

  expect(after.some((m) => m.type === "resync")).toBe(true);
});

test("attach 不带 lastSeq 时不补齐（首次挂载不该重放历史）", () => {
  const h = harness();
  h.agent.handle({ type: "attach", sessionId: "claude-refactor" });
  h.agent.emitOutput("claude-refactor", "a");
  const after: ServerMsg[] = [];
  h.agent.setPush((m) => after.push(m));
  h.agent.handle({ type: "attach", sessionId: "claude-refactor" });
  expect(after.filter((m) => m.type === "output")).toEqual([]);
});

test("修复：resync 判定按该会话自己的最老帧，不被别的会话挤爆缓冲误伤", () => {
  // 会话 A 早期发一帧后转静默；会话 B 狂产 REPLAY_CAP 帧把共享缓冲挤满。
  // A 用 lastSeq=1（对 A 而言一帧没漏）重连时不该被 B 的帧牵连误判缺口。
  const h = harness();
  h.agent.handle({ type: "attach", sessionId: "claude-refactor" }); // A
  h.agent.handle({ type: "attach", sessionId: "kimi-docs" });       // B
  h.agent.emitOutput("claude-refactor", "a-1"); // seq 1，A 唯一的一帧
  for (let i = 0; i < REPLAY_CAP; i++) h.agent.emitOutput("kimi-docs", `b${i}`); // 挤满缓冲，A 的帧被挤出

  h.agent.detachTransport();
  const after: ServerMsg[] = [];
  h.agent.setPush((m) => after.push(m));
  h.agent.handle({ type: "attach", sessionId: "claude-refactor", lastSeq: 1 });

  expect(after.filter((m) => m.type === "resync")).toEqual([]);
  expect(after.filter((m) => m.type === "output")).toEqual([]);
});

test("题眼验证：未 attach 时产出的帧仍先入缓冲，attach(lastSeq) 才能补齐——钉死顺序", () => {
  // 变异测试发现：把 emitOutput 里的 attached 判断挪到 replay.push 之前，
  // 之前的测试全部照样通过（因为断线测试里 attached 全程为 true）。这条
  // 测试用「从未 attach 就先产出」把顺序真正钉死：写反了这条必挂。
  const h = harness();
  h.agent.emitOutput("claude-refactor", "silent-1");
  h.agent.emitOutput("claude-refactor", "silent-2");
  expect(h.only("output")).toEqual([]); // 确实没投递（未 attach）

  h.agent.handle({ type: "attach", sessionId: "claude-refactor", lastSeq: 0 });
  const replayed = h.only("output");
  expect(replayed.map((o) => o.seq)).toEqual([1, 2]);
  expect(replayed.map((o) => decode(o.data))).toEqual(["silent-1", "silent-2"]);
});

test("真实模拟档：pwd / cd / ls 由假 FS 真实计算", () => {
  const h = harness();
  const run = (line: string) => {
    for (const ch of line + "\r") h.agent.handle({ type: "input", sessionId: "claude-refactor", data: btoa(ch) });
    h.tick();
  };
  h.agent.handle({ type: "attach", sessionId: "claude-refactor" });
  run("cd src");
  h.out.length = 0;
  run("pwd");
  expect(h.only("output").map((o) => decode(o.data)).join("")).toContain("/home/demo/project/src");
  h.out.length = 0;
  run("ls");
  const listed = h.only("output").map((o) => decode(o.data)).join("");
  expect(listed).toContain("auth.ts");
  expect(listed).toContain("crypto.ts");
});

test("真实模拟档：cat 读到真内容，读不存在的文件报错但不崩", () => {
  const h = harness();
  const run = (line: string) => {
    for (const ch of line + "\r") h.agent.handle({ type: "input", sessionId: "claude-refactor", data: btoa(ch) });
    h.tick();
  };
  h.agent.handle({ type: "attach", sessionId: "claude-refactor" });
  run("cat README.md");
  expect(h.only("output").map((o) => decode(o.data)).join("")).toContain("demo-project");
  h.out.length = 0;
  run("cat nope.txt");
  expect(h.only("output").map((o) => decode(o.data)).join("")).toContain("No such file");
});

test("脚本化档：claude 分段流出（不是一坨吐完）", () => {
  const h = harness();
  h.agent.handle({ type: "attach", sessionId: "claude-refactor" });
  for (const ch of "claude\r") h.agent.handle({ type: "input", sessionId: "claude-refactor", data: btoa(ch) });
  h.tick();
  const first = h.only("output").length;
  h.tick();
  expect(h.only("output").length).toBeGreaterThan(first); // 后续分段还在陆续到达
});

test("兜底档：任意乱输入回友好提示，且提示是 i18n 译出的中文（不是 key）", () => {
  const h = harness();
  h.agent.handle({ type: "attach", sessionId: "claude-refactor" });
  for (const ch of "sudo rm -rf /\r") h.agent.handle({ type: "input", sessionId: "claude-refactor", data: btoa(ch) });
  h.tick();
  const text = h.only("output").map((o) => decode(o.data)).join("");
  expect(text).not.toContain("demo.shell.fallback"); // 漏翻会把 key 直接铺给用户
  expect(text).toContain("沙盘");                     // vitest-setup.ts 固定 zh
});

test("clear 发送清屏控制序列", () => {
  const h = harness();
  h.agent.handle({ type: "attach", sessionId: "claude-refactor" });
  for (const ch of "clear\r") h.agent.handle({ type: "input", sessionId: "claude-refactor", data: btoa(ch) });
  h.tick();
  expect(h.only("output").map((o) => decode(o.data)).join("")).toContain("\x1b[2J");
});

test("空回车只给提示符，不报错", () => {
  const h = harness();
  h.agent.handle({ type: "attach", sessionId: "claude-refactor" });
  h.agent.handle({ type: "input", sessionId: "claude-refactor", data: btoa("\r") });
  h.tick();
  const text = h.only("output").map((o) => decode(o.data)).join("");
  expect(text).not.toContain("No such file");
  expect(text.trimEnd().endsWith("$")).toBe(true);
});
