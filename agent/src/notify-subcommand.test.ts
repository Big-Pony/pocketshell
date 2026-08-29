import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parseNotifyPayload } from "./notify-subcommand";

const withSession = { POCKETSHELL_NOTIFY_SESSION: "work" };

function tmpHome() {
  const home = mkdtempSync(join(tmpdir(), "ps-notify-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  return { home, restore: () => { process.env.HOME = prev; } };
}

test("no PocketShell session -> null", async () => {
  expect(await parseNotifyPayload({}, [], "")).toBeNull();
});

test("codex agent-turn-complete from argv JSON", async () => {
  const j = JSON.stringify({ type: "agent-turn-complete", "last-assistant-message": "All tests passed" });
  const r = await parseNotifyPayload(withSession, [j], "");
  expect(r).toEqual({ sessionId: "work", title: "work", body: "All tests passed" });
});

test("claude hook from stdin JSON", async () => {
  const j = JSON.stringify({ message: "Awaiting your input" });
  const r = await parseNotifyPayload(withSession, [], j);
  expect(r?.sessionId).toBe("work");
  expect(r?.body).toContain("Awaiting");
});

test("opencode/no payload falls back to generic body", async () => {
  const r = await parseNotifyPayload(withSession, [], "");
  expect(r).toEqual({ sessionId: "work", title: "work", body: "" });
});

// 关键：kimi 的 session_id 与 PocketShell 的会话名【刻意不同】。
// 此前两者都写成 "work"，无论用哪个去拼路径测试都绿——真实环境里
// PocketShell 会话名是 tmux 名（如 "pocketshell"），kimi 的是 uuid，
// 拿错了永远指向不存在的目录。这里用不同的值才能锁住这个区分。
test("tool arg is extracted and token read from kimi session file", async () => {
  const { home, restore } = tmpHome();
  try {
    const cwd = "/home/user/kimi-project";
    const md5 = createHash("md5").update(cwd).digest("hex");
    const kimiSid = "8f3c1d2e-aaaa-bbbb-cccc-1234567890ab";  // ≠ withSession 的 "work"
    const dir = join(home, ".kimi", "sessions", md5, kimiSid);
    mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({
      timestamp: 1,
      message: { type: "StatusUpdate", payload: { context_tokens: 12345, max_context_tokens: 262144 } },
    });
    writeFileSync(join(dir, "wire.jsonl"), line);
    const r = await parseNotifyPayload(withSession, ["kimi"], JSON.stringify({ session_id: kimiSid, cwd }));
    expect(r?.tool).toBe("kimi");
    expect(r?.ctx).toEqual({ used: 12345, total: 262144 });
    // 通知的 sessionId 仍是 PocketShell 的会话名，两者不能混
    expect(r?.sessionId).toBe("work");
  } finally { restore(); }
});

test("tool arg without cwd does not crash and skips token read", async () => {
  const r = await parseNotifyPayload(withSession, ["kimi"], JSON.stringify({ session_id: "work" }));
  expect(r?.tool).toBe("kimi");
  expect(r?.ctx).toBeUndefined();
});

test("codex uses thread-id without requiring cwd", async () => {
  const { home, restore } = tmpHome();
  try {
    const thread = "019abcde-aaaa-bbbb-cccc-1234567890ab";
    const dir = join(home, ".codex", "sessions", "2026", "08", "29");
    mkdirSync(dir, { recursive: true });
    const event = JSON.stringify({
      type: "event_msg",
      payload: { type: "token_count", info: {
        last_token_usage: { input_tokens: 42000 },
        total_token_usage: { input_tokens: 999999 },
        model_context_window: 258400,
      } },
    });
    writeFileSync(join(dir, `rollout-now-${thread}.jsonl`), event + "\n");
    const hook = JSON.stringify({ type: "agent-turn-complete", "thread-id": thread, "last-assistant-message": "done" });
    const r = await parseNotifyPayload(withSession, ["codex", hook], "");
    expect(r?.body).toBe("done");
    expect(r?.ctx).toEqual({ used: 42000, total: 258400 });
  } finally { restore(); }
});
