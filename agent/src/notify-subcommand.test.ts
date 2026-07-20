import { expect, test } from "bun:test";
import { parseNotifyPayload } from "./notify-subcommand";

const withSession = { POCKETSHELL_NOTIFY_SESSION: "work" };

test("no PocketShell session -> null", () => {
  expect(parseNotifyPayload({}, [], "")).toBeNull();
});

test("codex agent-turn-complete from argv JSON", () => {
  const j = JSON.stringify({ type: "agent-turn-complete", "last-assistant-message": "All tests passed" });
  const r = parseNotifyPayload(withSession, [j], "");
  expect(r).toEqual({ sessionId: "work", title: "work", body: "All tests passed" });
});

test("claude hook from stdin JSON", () => {
  const j = JSON.stringify({ message: "Awaiting your input" });
  const r = parseNotifyPayload(withSession, [], j);
  expect(r?.sessionId).toBe("work");
  expect(r?.body).toContain("Awaiting");
});

test("opencode/no payload falls back to generic body", () => {
  const r = parseNotifyPayload(withSession, [], "");
  expect(r).toEqual({ sessionId: "work", title: "work", body: "" });
});
