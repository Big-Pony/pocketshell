// per-session 的 AI 上下文用量。数据由各工具的 hook / statusLine 在回合结束
// 时经 loopback POST 推上来（见 server.ts 的 /internal/notify），这里只负责
// 存与贴到 sessions 广播上。
//
// 刻意不落盘：重启后等下一轮 hook 补上即可，一个会随时被覆盖的瞬时数字
// 不值得一个持久化文件与它的一致性问题。
import type { SessionMeta } from "./protocol";
import type { AiContext, AiTool } from "./ai-context";

interface Entry { tool: AiTool; used: number; total?: number; at: number; }

export class ContextStore {
  private map = new Map<string, Entry>();

  set(sessionId: string, tool: AiTool, ctx: AiContext, now: number): void {
    this.map.set(sessionId, { tool, used: ctx.used, total: ctx.total, at: now });
  }

  get(sessionId: string): { tool: AiTool; used: number; total?: number } | undefined {
    const e = this.map.get(sessionId);
    return e ? { tool: e.tool, used: e.used, total: e.total } : undefined;
  }

  delete(sessionId: string): void { this.map.delete(sessionId); }

  // 返回新数组、新对象：sessions-diff 的比较依赖对象不被原地改写，
  // 就地污染入参会让上一轮的 lastPushed 也跟着变，diff 永远判定相等。
  decorate(sessions: SessionMeta[]): SessionMeta[] {
    return sessions.map((s) => {
      const e = this.map.get(s.name);
      if (!e) return { ...s };
      return { ...s, ctxTool: e.tool, ctxUsed: e.used, ctxTotal: e.total };
    });
  }
}
