import { describe, expect, test } from "bun:test";
import {
  ChannelWatchdog,
  WATCHDOG_CANDIDATE_MS,
  WATCHDOG_MIN_EVIDENCE_BYTES,
} from "./channel-watchdog";

/**
 * 窗格通道看门狗的判定表（2026-08-27）。
 *
 * 背景：B2 通道是 tmux pipe-pane → tee → FIFO → cat → agent pump 的长链，
 * 任何一环瞬时阻塞（Bun pump 停止消费 / cat 卡死 / tee 卡盘）都表现为
 * 「会话活着、屏幕却永远不动」。2026-08-27 真机实锤一例：36 秒零字节，
 * 期间 tap 文件（pane 侧原始旁录）有增长而 agent 侧 rx 冻结，链路其余
 * 环节全部完好、自行复流。看门狗不猜是哪一环坏了——判定只看两个无歧义的
 * 事实，修复统一走「重建通道」（tmux 的 pipe_offset 会续传，字节不丢）：
 *
 *   事实 A：agent 侧 rx 冻结（自 lastOutputAt 起无任何字节）
 *   事实 B：pane 在产出（tap 旁录字节数增长 或 tmux history_size 增长）
 *
 * A 且 B = 链路某处确实堵了 → 重建。只有 A（纯空闲）→ 什么都不做。
 * 探头只读「字节数 / 行数」，永不读内容——tap 里有真实会话原文，绝不碰。
 */
describe("ChannelWatchdog", () => {
  const feed = (wd: ChannelWatchdog, at: number, rx: number, tap: number, hist: number) =>
    wd.feed({ now: at, rxBytes: rx, tapBytes: tap, historySize: hist });

  test("会话产出、rx 冻结 ≥ 候选窗 → 判定重建", () => {
    const wd = new ChannelWatchdog();
    // 每 1s 喂一次：pane 一直在写 tap（+100B/tick），rx 从 1000 起冻住。
    // 窗内（1..5s）必须 idle；满 6s 那一拍判定 rebuild。
    feed(wd, 0, 1000, 500, 10);
    for (let i = 1; i < WATCHDOG_CANDIDATE_MS / 1000; i++) {
      expect(feed(wd, i * 1000, 1000, 500 + i * 100, 10 + i)).toBe("idle");
    }
    expect(feed(wd, WATCHDOG_CANDIDATE_MS, 1000, 500 + 6 * 100, 16)).toBe("rebuild");
  });

  test("纯空闲（rx 冻结但 tap/hist 都不动）→ 永不重建", () => {
    const wd = new ChannelWatchdog();
    feed(wd, 0, 1000, 500, 10);
    for (let i = 1; i <= 30; i++) {
      expect(feed(wd, i * 1000, 1000, 500, 10)).toBe("idle");
    }
  });

  test("rx 正常流动 → 什么都不做（哪怕 tap/hist 在涨）", () => {
    const wd = new ChannelWatchdog();
    feed(wd, 0, 1000, 500, 10);
    for (let i = 1; i <= 30; i++) {
      expect(feed(wd, i * 1000, 1000 + i * 200, 500 + i * 100, 10 + i)).toBe("idle");
    }
  });

  test("冻结时长不够（< 候选窗）→ 不判定，避免误伤跨 tick 的正常突发", () => {
    const wd = new ChannelWatchdog();
    feed(wd, 0, 1000, 500, 10);
    // 4.9s：tap 在涨，但还没到候选窗。
    expect(feed(wd, 4900, 1000, 990, 14)).toBe("idle");
  });

  test("tap 增量低于证据阈值（纯噪声）→ 不判定", () => {
    const wd = new ChannelWatchdog();
    feed(wd, 0, 1000, 500, 10);
    for (let i = 1; i < WATCHDOG_CANDIDATE_MS / 1000; i++)
      expect(feed(wd, i * 1000, 1000, 500, 10)).toBe("idle");
    // 6s 后 tap 只涨了 2 字节：不足以证明 pane 在产出。
    expect(feed(wd, (WATCHDOG_CANDIDATE_MS / 1000 + 1) * 1000, 1000, 502, 10)).toBe("idle");
  });

  test("hist 增长（无 tap）同样构成 pane 产出的证据", () => {
    const wd = new ChannelWatchdog();
    feed(wd, 0, 1000, 500, 10);
    for (let i = 1; i < WATCHDOG_CANDIDATE_MS / 1000; i++)
      expect(feed(wd, i * 1000, 1000, 500, 10)).toBe("idle");
    expect(feed(wd, (WATCHDOG_CANDIDATE_MS / 1000 + 1) * 1000, 1000, 500, 15)).toBe("rebuild");
  });

  test("rebuild 之后状态归零，不会立即再次触发", () => {
    const wd = new ChannelWatchdog();
    feed(wd, 0, 1000, 500, 10);
    for (let i = 1; i < WATCHDOG_CANDIDATE_MS / 1000; i++) feed(wd, i * 1000, 1000, 500, 10);
    expect(feed(wd, (WATCHDOG_CANDIDATE_MS / 1000 + 1) * 1000, 1000, 700, 15)).toBe("rebuild");
    // 重建后 rx 继续冻结、tap 继续涨（若链路还堵）→ 需要重新等满一个候选窗。
    const t0 = (WATCHDOG_CANDIDATE_MS / 1000 + 1) * 1000;
    for (let i = 1; i < WATCHDOG_CANDIDATE_MS / 1000; i++)
      expect(feed(wd, t0 + i * 1000, 1000, 700 + i * 100, 15 + i)).toBe("idle");
    expect(feed(wd, t0 + (WATCHDOG_CANDIDATE_MS / 1000 + 1) * 1000, 1000, 900, 20)).toBe("rebuild");
  });

  test("rx 恢复流动会复位候选计时", () => {
    const wd = new ChannelWatchdog();
    feed(wd, 0, 1000, 500, 10);
    for (let i = 1; i < WATCHDOG_CANDIDATE_MS / 1000; i++)
      feed(wd, i * 1000, 1000, 500 + i * 100, 10 + i);
    // 第 5 秒 rx 恢复（链路自己疏通了）→ 计时从头来。
    expect(feed(wd, 5000, 1500, 900, 14)).toBe("idle");
    for (let i = 6; i <= 10; i++)
      expect(feed(wd, i * 1000, 1500, 500, 14)).toBe("idle");
  });
});
