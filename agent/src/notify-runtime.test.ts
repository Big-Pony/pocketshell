import { expect, test } from "bun:test";
import { resolveNotifyRuntime } from "./notify-runtime";

test("uses fully seeded PocketShell environment", () => {
  const r = resolveNotifyRuntime({
    POCKETSHELL_NOTIFY_SESSION: "work",
    POCKETSHELL_NOTIFY_URL: "http://127.0.0.1:9000/internal/notify",
    POCKETSHELL_NOTIFY_TOKEN: "tok",
  }, { tmuxSession: () => { throw new Error("unused"); }, loadConfig: () => { throw new Error("unused"); } });
  expect(r).toEqual({ sessionId: "work", url: "http://127.0.0.1:9000/internal/notify", token: "tok" });
});

test("recovers session and endpoint for a pre-existing tmux shell", () => {
  const r = resolveNotifyRuntime({ TMUX_PANE: "%7" }, {
    tmuxSession: (pane) => pane === "%7" ? "codex-work" : null,
    loadConfig: () => ({ listen: { host: "127.0.0.1", port: 8722 }, notifyToken: "secret" }),
  });
  expect(r).toEqual({ sessionId: "codex-work", url: "http://127.0.0.1:8722/internal/notify", token: "secret" });
});

test("does not activate a global hook outside tmux", () => {
  expect(resolveNotifyRuntime({}, {
    tmuxSession: () => "wrong",
    loadConfig: () => ({ listen: { host: "127.0.0.1", port: 8722 }, notifyToken: "secret" }),
  })).toBeNull();
});

