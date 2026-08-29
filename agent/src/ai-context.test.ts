import { expect, test } from "bun:test";
import { parseAiContext } from "./ai-context";

// ---- kimi：夹具取自本机 ~/.kimi/sessions/*/wire.jsonl 实测数据 ----

const kimiLine = (ctx: number, max: number) => JSON.stringify({
  timestamp: 1773320443.18105,
  message: { type: "StatusUpdate", payload: {
    context_usage: ctx / max, context_tokens: ctx, max_context_tokens: max,
    token_usage: { input_other: 500, output: 202, input_cache_read: 62976, input_cache_creation: 0 },
    message_id: "chatcmpl-x",
  } },
});

// 本机实测：部分会话（疑似旧版）的 StatusUpdate 没有 context_tokens 字段
const kimiLineNoTokens = JSON.stringify({
  timestamp: 1773320443.1,
  message: { type: "StatusUpdate", payload: {
    context_usage: 0.026, token_usage: { input_other: 1463, output: 50 }, message_id: "chatcmpl-y",
  } },
});

const kimiNoise = JSON.stringify({ timestamp: 1, message: { type: "ContentPart", payload: { text: "hi" } } });

test("kimi: 取最后一条带齐字段的 StatusUpdate", () => {
  const text = [kimiLine(1000, 262144), kimiNoise, kimiLine(63476, 262144), kimiNoise].join("\n");
  expect(parseAiContext("kimi", text)).toEqual({ used: 63476, total: 262144 });
});

test("kimi: 跳过没有 token 字段的 StatusUpdate（旧版格式）", () => {
  const text = [kimiLine(5000, 262144), kimiLineNoTokens, kimiLineNoTokens].join("\n");
  expect(parseAiContext("kimi", text)).toEqual({ used: 5000, total: 262144 });
});

test("kimi: 全是无 token 字段的记录返回 null", () => {
  expect(parseAiContext("kimi", [kimiLineNoTokens, kimiLineNoTokens].join("\n"))).toBeNull();
});

test("kimi: 开头残缺行不影响后面的解析（尾部截断场景）", () => {
  const text = ['ge":{"type":"Stat', kimiLine(777, 262144)].join("\n");
  expect(parseAiContext("kimi", text)).toEqual({ used: 777, total: 262144 });
});

// ---- claude：夹具取自本机 ~/.claude/projects/*/*.jsonl 实测数据 ----

const claudeLine = (inp: number, cc: number, cr: number) => JSON.stringify({
  type: "assistant", sessionId: "s1", cwd: "/x",
  message: { model: "claude-opus-5", role: "assistant", usage: {
    input_tokens: inp, cache_creation_input_tokens: cc, cache_read_input_tokens: cr,
    output_tokens: 775, service_tier: "standard",
  } },
});

const claudeUser = JSON.stringify({ type: "user", sessionId: "s1", message: { role: "user", content: "hi" } });

test("claude: used = input + cache_creation + cache_read，无 total", () => {
  const text = [claudeLine(2, 1000, 50000), claudeUser, claudeLine(2, 1243, 141919), claudeUser].join("\n");
  // 2 + 1243 + 141919 = 143164
  expect(parseAiContext("claude", text)).toEqual({ used: 143164, total: undefined });
});

test("claude: 忽略非 assistant 记录", () => {
  const text = [claudeLine(2, 100, 200), claudeUser, claudeUser].join("\n");
  expect(parseAiContext("claude", text)).toEqual({ used: 302, total: undefined });
});

test("claude: 缺失的 cache 字段按 0 计", () => {
  const text = JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 500 } } });
  expect(parseAiContext("claude", text)).toEqual({ used: 500, total: undefined });
});

test("claude: 无 assistant 记录返回 null", () => {
  expect(parseAiContext("claude", [claudeUser, claudeUser].join("\n"))).toBeNull();
});

// ---- codex：按官方 rollout 格式（本机未安装 codex，夹具依据社区文档） ----

const codexLine = (inp: number, win: number) => JSON.stringify({
  type: "token_count",
  info: {
    last_token_usage: { input_tokens: inp, output_tokens: 100 },
    total_token_usage: { input_tokens: 999999, output_tokens: 88888 }, // 会话累计，勿用
    model_context_window: win,
  },
});

test("codex: 用 last_token_usage 而非 total_token_usage", () => {
  const text = [codexLine(1000, 272000), codexLine(45000, 272000)].join("\n");
  expect(parseAiContext("codex", text)).toEqual({ used: 45000, total: 272000 });
});

test("codex: 解析当前 event_msg.payload 包装的 token_count", () => {
  const wrapped = JSON.stringify({
    type: "event_msg",
    payload: JSON.parse(codexLine(36794, 258400)),
  });
  expect(parseAiContext("codex", wrapped)).toEqual({ used: 36794, total: 258400 });
});

test("codex: 无 token_count 记录返回 null", () => {
  expect(parseAiContext("codex", JSON.stringify({ type: "response_item" }))).toBeNull();
});

// ---- 通用边界 ----

test("空文本返回 null", () => {
  for (const t of ["claude", "kimi", "codex"] as const) {
    expect(parseAiContext(t, "")).toBeNull();
    expect(parseAiContext(t, "\n\n\n")).toBeNull();
  }
});

test("全是垃圾文本返回 null 而不抛异常", () => {
  for (const t of ["claude", "kimi", "codex"] as const) {
    expect(parseAiContext(t, "not json at all\n{{{\n]]]")).toBeNull();
  }
});

test("opencode 不走文件解析，一律返回 null", () => {
  // opencode 的落盘格式版本不稳定，数据由插件经 SDK 直接上报（见 Task 15）
  expect(parseAiContext("opencode", kimiLine(1, 2))).toBeNull();
});
