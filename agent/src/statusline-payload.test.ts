import { expect, test } from "bun:test";
import { parseStatuslinePayload } from "./statusline-payload";

// 夹具依据官方文档 https://code.claude.com/docs/en/statusline 的字段表
const full = JSON.stringify({
  session_id: "abc-123",
  cwd: "/Volumes/ssd/project",
  model: { display_name: "Opus 5" },
  context_window: {
    total_input_tokens: 142000,
    total_output_tokens: 4521,
    context_window_size: 1000000,
    used_percentage: 14,
    remaining_percentage: 86,
    current_usage: {
      input_tokens: 8500, output_tokens: 1200,
      cache_creation_input_tokens: 5000, cache_read_input_tokens: 128500,
    },
  },
});

test("解析完整载荷", () => {
  expect(parseStatuslinePayload(full)).toEqual({
    sessionId: "abc-123", cwd: "/Volumes/ssd/project", used: 142000, total: 1000000,
  });
});

test("current_usage 为 null 时仍能取到 total_input_tokens", () => {
  // 官方文档：首次 API 调用前、/compact 之后 current_usage 为 null
  const s = JSON.stringify({
    session_id: "s", cwd: "/x",
    context_window: { total_input_tokens: 0, context_window_size: 200000, current_usage: null },
  });
  expect(parseStatuslinePayload(s)).toEqual({ sessionId: "s", cwd: "/x", used: 0, total: 200000 });
});

test("完全没有 context_window 时仍返回会话身份，token 缺省", () => {
  const s = JSON.stringify({ session_id: "s", cwd: "/x", model: { display_name: "Opus" } });
  expect(parseStatuslinePayload(s)).toEqual({ sessionId: "s", cwd: "/x", used: undefined, total: undefined });
});

test("缺 session_id 返回 null（无法归属，没有意义）", () => {
  const s = JSON.stringify({ cwd: "/x", context_window: { total_input_tokens: 1, context_window_size: 2 } });
  expect(parseStatuslinePayload(s)).toBeNull();
});

test("非 JSON 返回 null 而不抛异常", () => {
  expect(parseStatuslinePayload("not json")).toBeNull();
  expect(parseStatuslinePayload("")).toBeNull();
});

test("context_window 字段类型异常时视为缺省", () => {
  const s = JSON.stringify({
    session_id: "s", cwd: "/x",
    context_window: { total_input_tokens: "many", context_window_size: null },
  });
  expect(parseStatuslinePayload(s)).toEqual({ sessionId: "s", cwd: "/x", used: undefined, total: undefined });
});
