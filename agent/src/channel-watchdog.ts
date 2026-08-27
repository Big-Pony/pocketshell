// 窗格通道看门狗：判定 B2 通道是否「堵住了但没死」。
//
// 【为什么需要它】B2 通道是 tmux pipe-pane → tee → FIFO → cat → agent pump 的
// 长链。任何一环瞬时阻塞（Bun pump 停止消费 / cat 卡死 / tee 卡盘）都表现为
// 「会话活着、屏幕却永远不动、打字无回显」——cat 不退出（O_RDWR fd 堵住了
// EOF，见 pane-channel.ts 文件头）、tmux 不报错、agent 无异常，进程链完好得
// 像什么都没发生。2026-08-27 真机实锤一例（pocketshell 会话）：36 秒零字节，
// 期间 tap 旁录字节数有增长而 agent 侧 rx 冻结，无 drop / seqgap / 重连，
// 链路其余环节事后检查全部完好——瞬时阻塞自行复流。这类故障此前在日志里
// 完全不可见。
//
// 【判定逻辑】不猜是哪一环坏了，只看两个无歧义的事实：
//   事实 A：agent 侧 rx 冻结（自 lastOutputAt 起无任何字节）
//   事实 B：pane 在产出（tap 旁录字节数增长 或 tmux history_size 增长）
// A 且 B = 链路某处确实堵了 → 重建通道。只有 A（纯空闲）→ 什么都不做。
// 修复统一走「重建」：tmux 的 pipe_offset 在 pipe-pane 重开后续传（见
// cmd-pipe-pane.c——重开不重置 wpo），堵在半路的字节会从新通道流出来，
// 字节不丢。
//
// 【隐私】探头只读「字节数 / 行数」（tap 文件 stat size、history_size 计数），
// 永不读 tap 内容——tap 里是真实会话原文，与 pane-tap 的红线一致。
//
// 【误伤面】唯一需要防的误判是「跨 tick 的正常突发被看成 rx 冻结」：字节
// 只晚到一秒但 tap/hist 都在涨。防法是候选窗（默认 6s）：冻结必须持续满
// 一整个窗、且窗内 pane 产出证据 ≥ MIN_EVIDENCE_BYTES 才判定。一次误重建
// 的代价也不高（字节续传不丢），但宁可让它更难发生。

/** rx 冻结持续多久才进入判定（ms）。覆盖跨 tick 突发的抖动。 */
export const WATCHDOG_CANDIDATE_MS = 6000;

/** 窗内 pane 产出至少这么多字节才算证据（防 stat 粒度噪声）。 */
export const WATCHDOG_MIN_EVIDENCE_BYTES = 64;

export interface WatchdogSample {
  now: number;
  /** agent 侧累计收到的字节数（onData 累计，单调）。 */
  rxBytes: number;
  /** tap 旁录文件大小（纯 stat，不读内容）。tap 关闭时传 null。 */
  tapBytes: number | null;
  /** tmux #{history_size}。取不到时传 null。 */
  historySize: number | null;
}

export type WatchdogVerdict = "idle" | "rebuild";

export class ChannelWatchdog {
  /** 候选起点：rx 首次冻结时刻的快照。null = 不在候选状态。 */
  private candidate: { at: number; rxBytes: number; tapBytes: number | null; historySize: number | null } | null = null;

  feed(s: WatchdogSample): WatchdogVerdict {
    if (this.candidate === null) {
      // 不在候选状态：rx 在动（或刚被复位），把此刻记为基准。
      this.candidate = { at: s.now, rxBytes: s.rxBytes, tapBytes: s.tapBytes, historySize: s.historySize };
      return "idle";
    }
    if (s.rxBytes !== this.candidate.rxBytes) {
      // rx 恢复流动：复位候选计时。
      this.candidate = { at: s.now, rxBytes: s.rxBytes, tapBytes: s.tapBytes, historySize: s.historySize };
      return "idle";
    }
    if (s.now - this.candidate.at < WATCHDOG_CANDIDATE_MS) return "idle";
    // rx 冻结满一个候选窗。pane 在产出吗？tap 与 hist 取其一即可，
    // 某一侧取不到（null）就退化为只看另一侧。
    const tapEvidence =
      this.candidate.tapBytes !== null && s.tapBytes !== null
        ? s.tapBytes - this.candidate.tapBytes >= WATCHDOG_MIN_EVIDENCE_BYTES
        : false;
    const histEvidence =
      this.candidate.historySize !== null && s.historySize !== null
        ? s.historySize > this.candidate.historySize
        : false;
    if (tapEvidence || histEvidence) {
      // 判定成立：归零重来。重建后若链路还堵，会重新等满一个候选窗再触发。
      this.candidate = null;
      return "rebuild";
    }
    return "idle";
  }
}
