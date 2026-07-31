// Pure parser for the `pocketshell-agent notify` subcommand. Each agent tool
// hands the completion payload differently: Codex passes JSON as argv[0]
// (last-assistant-message), Claude Code pipes a hook JSON on stdin, opencode's
// plugin may pass nothing.
//
// 新版接线会把工具名作为 argv[0] 传进来（如 `pocketshell-agent notify kimi`），
// 这样我们才知道该按哪个工具的落盘格式读尾部 token。老版没有工具名时回退到
// 纯通知行为，保证兼容性。
import type { AiContext, AiTool } from "./ai-context";
import { parseAiContext } from "./ai-context";
import { readTail } from "./ai-session-path";

const AI_TOOLS = new Set<AiTool>(["claude", "kimi", "codex", "opencode"]);

export interface NotifyPayload {
  sessionId: string;
  title: string;
  body: string;
  tool?: AiTool;
  ctx?: AiContext;
}

export async function parseNotifyPayload(
  env: Record<string, string | undefined>,
  argv: string[],
  stdin: string,
): Promise<NotifyPayload | null> {
  const sessionId = env.POCKETSHELL_NOTIFY_SESSION;
  if (!sessionId) return null;

  let tool: AiTool | undefined;
  let restArgv = argv;
  if (AI_TOOLS.has(argv[0] as AiTool)) {
    tool = argv[0] as AiTool;
    restArgv = argv.slice(1);
  }

  const tryJson = (s: string): any => { try { return JSON.parse(s); } catch { return null; } };
  const fromArgv = restArgv[0] ? tryJson(restArgv[0]) : null;
  const fromStdin = stdin ? tryJson(stdin) : null;
  const j = fromArgv ?? fromStdin;

  let body = "";
  if (j && typeof j === "object") {
    body = String(j["last-assistant-message"] ?? j.message ?? j.body ?? j.text ?? "");
  } else if (stdin.trim()) {
    body = stdin.trim();
  }

  let ctx: AiContext | undefined;
  if (tool && tool !== "opencode" && j && typeof j === "object") {
    // 定位落盘文件要用【工具自己的 session_id】（hook JSON 里的那个），
    // 不是 PocketShell 的会话名 —— 后者是 tmux 会话名（如 "pocketshell"），
    // 拿它去拼 ~/.kimi/sessions/<md5>/<id>/ 或 ~/.claude/projects/<slug>/<id>.jsonl
    // 永远指向不存在的路径。
    // codex 例外：它按 cwd 从 rollout 里找，sessionId 用不上（见 codexSessionPath）。
    const cwd = typeof j.cwd === "string" ? j.cwd : "";
    const toolSessionId = typeof j.session_id === "string" ? j.session_id : "";
    if (cwd && (toolSessionId || tool === "codex")) {
      try {
        const tail = await readTail(tool, cwd, toolSessionId);
        ctx = parseAiContext(tool, tail) ?? undefined;
      } catch { /* 读文件失败时只少显示 token，不阻断通知 */ }
    }
  }

  return { sessionId, title: sessionId, body, tool, ctx };
}
