// 四幕场景脚本：派活 → 断线 → 推送 → 重连补齐。
//
// 第 2–4 幕独立成 playDropScene()，因为常驻的「试试断网」按钮要单独跑它——
// 题眼不能依赖「访客恰好 8 秒没动」这个运气（设计文档 4.4）。
//
// Director 不认识 Connection，只认识注入的 drop() 回调，所以它可单测。
import type { DemoAgent, DemoScheduler } from "./agent";
import { tr } from "../lib/i18n";

export const AUTO_PLAY_DELAY_MS = 8000;

const SESSION = "claude-refactor";

export interface DirectorOpts {
  agent: DemoAgent;
  /** 断线：工厂注入 conn.dropConnection()。 */
  drop(): void;
  scheduler?: DemoScheduler;
  autoPlayDelayMs?: number;
}

export class DemoDirector {
  private readonly agent: DemoAgent;
  private readonly drop: () => void;
  private readonly sched: DemoScheduler;
  private readonly autoDelay: number;
  /** 本轮演出的所有定时器；停演/重入时统一清掉，避免两轮互相打架。 */
  private timers: number[] = [];
  private stopped = false;

  constructor(opts: DirectorOpts) {
    this.agent = opts.agent;
    this.drop = opts.drop;
    this.autoDelay = opts.autoPlayDelayMs ?? AUTO_PLAY_DELAY_MS;
    this.sched = opts.scheduler ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
      clearTimeout: (id) => clearTimeout(id),
    };
  }

  /** 8 秒无操作后自动开演。 */
  armAutoPlay(): void {
    this.at(this.autoDelay, () => this.playAll());
  }

  /** 任何访客输入都立即停演，之后完全交给访客。 */
  notifyUserInput(): void {
    this.stopped = true;
    this.clearTimers();
  }

  /** 常驻「试试断网」按钮的入口：第 2–4 幕。 */
  playDropScene(): void {
    this.restart();
    this.act2Drop(0);
  }

  private playAll(): void {
    this.act1Assign();
    this.act2Drop(3600); // 派活演完再断
  }

  /** 第一幕：输入法整段注入一段中文需求，然后跑 claude。 */
  private act1Assign(): void {
    const prompt = tr("demo.scene.prompt");
    this.at(0, () => this.agent.emitOutput(SESSION, `\r\n\x1b[38;5;208m~/demo\x1b[0m $ claude "${prompt}"\r\n`));
    this.at(700, () => this.agent.emitOutput(SESSION, "\x1b[38;5;208m⏺\x1b[0m Analyzing src/auth.ts …\r\n"));
    this.at(1700, () => this.agent.emitOutput(SESSION, "  Read src/auth.ts (18 lines)\r\n"));
    this.at(2600, () => this.agent.emitOutput(SESSION, "  Read src/crypto.ts (21 lines)\r\n"));
  }

  /** 第二幕：真的断开（走 Connection 自己的重连路径，不是伪造的状态）。 */
  private act2Drop(delay: number): void {
    this.at(delay, () => this.drop());
    // —— 断线期间 agent 照跑：这几帧推不出去，但已经进了 replay 缓冲 ——
    this.at(delay + 600,  () => this.agent.emitOutput(SESSION, "\x1b[38;5;208m⏺\x1b[0m Editing src/auth.ts …\r\n"));
    this.at(delay + 1500, () => this.agent.emitOutput(SESSION, "  + if (!claims) return null;\r\n"));
    this.at(delay + 2400, () => this.agent.emitOutput(SESSION, "  Wrote src/auth.ts (1 insertion)\r\n"));
    this.at(delay + 3200, () => this.act3Push());
    this.at(delay + 4000, () => this.agent.emitOutput(SESSION, "\x1b[38;5;208m⏺\x1b[0m Waiting for your confirmation…\r\n"));
  }

  /** 第三幕：推送。第四幕（补齐）由 Connection 重连后 attach(lastSeq) 自动完成。 */
  private act3Push(): void {
    this.agent.pushNotification(SESSION, tr("demo.scene.pushTitle"), tr("demo.scene.pushBody"));
  }

  private restart(): void {
    this.clearTimers();
    this.stopped = false;
  }

  private at(ms: number, fn: () => void): void {
    const id = this.sched.setTimeout(() => { if (!this.stopped) fn(); }, ms);
    this.timers.push(id);
  }

  private clearTimers(): void {
    for (const id of this.timers) this.sched.clearTimeout(id);
    this.timers = [];
  }
}
