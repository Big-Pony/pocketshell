#!/usr/bin/env bun
/**
 * 读 agent 日志，按「终端内容丢失」的判定流程直接给结论。
 *
 * 为什么有这个脚本：2026-08-22 排查那个「中间少几行」的故障时，每看一次日志都要
 * 现写一段 grep + python 来解析 JSON、按会话分组、按时间对齐。埋点补齐之后，
 * 判定流程本身是**固定**的（见 docs/域/终端与会话.md 的「诊断埋点」），固定的
 * 流程就该是脚本而不是每次重敲。
 *
 *   bun run scripts/diag-triage.ts                     # 最近 2 小时，全部会话
 *   bun run scripts/diag-triage.ts --session pocketshell --hours 6
 *   bun run scripts/diag-triage.ts --log /path/to/agent.out.log
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const PREFIX = "[pocketshell:diag]";
const argv = process.argv.slice(2);
const argOf = (name: string, dflt?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const LOG = argOf("log", join(homedir(), "Library/Logs/pocketshell/agent.out.log"))!;
const HOURS = Number(argOf("hours", "2"));
const ONLY = argOf("session");

interface Rec { ts: string; tag: string; kind: string; [k: string]: unknown }

const since = new Date(Date.now() - HOURS * 3600_000).toISOString();
let text: string;
try {
  text = readFileSync(LOG, "utf8");
} catch (e) {
  console.error(`读不到日志：${LOG}\n${e}`);
  process.exit(1);
}

const recs: Rec[] = [];
for (const line of text.split("\n")) {
  const i = line.indexOf(PREFIX);
  if (i < 0) continue;
  try {
    const r = JSON.parse(line.slice(i + PREFIX.length).trim()) as Rec;
    if (!r.ts || r.ts < since) continue;
    // tag 形如 "会话名" 或 "会话名/activate"
    const base = String(r.tag ?? "").split("/")[0];
    if (ONLY && base !== ONLY) continue;
    // 噪音过滤（非 --session 模式下）：
    //   - 空 tag：rpc 压缩埋点不带会话名，与本判定流程无关；
    //   - pocketshell_test_*：单测/集成测试跑过留下的临时会话名。
    if (!ONLY && (base === "" || /^pocketshell_test_/.test(base))) continue;
    recs.push({ ...r, tag: base });
  } catch { /* 半行/损坏行跳过——日志是 append 的，最后一行可能没写完 */ }
}

if (recs.length === 0) {
  console.log(`最近 ${HOURS} 小时内没有诊断记录${ONLY ? `（会话 ${ONLY}）` : ""}。`);
  process.exit(0);
}

const bySession = new Map<string, Rec[]>();
for (const r of recs) {
  const a = bySession.get(r.tag) ?? [];
  a.push(r);
  bySession.set(r.tag, a);
}

const hhmmss = (ts: string) => ts.slice(11, 19);
const n = (v: unknown) => (typeof v === "number" ? v : undefined);

console.log(`日志：${LOG}`);
console.log(`范围：最近 ${HOURS} 小时（${hhmmss(since)} 起，UTC）\n`);

for (const [session, rs] of [...bySession].sort()) {
  const gaps = rs.filter((r) => r.kind === "seqgap");
  const drops = rs.filter((r) => r.kind === "drop");
  const screens = rs.filter((r) => r.kind === "screen");
  const writes = rs.filter((r) => r.kind === "write");
  const renders = rs.filter((r) => r.kind === "render");

  console.log(`━━ ${session} ━━`);

  // 步骤 1/2：帧真的丢了吗
  if (gaps.length) {
    console.log(`  ⚠ seq 缺口 ${gaps.length} 次 —— 帧真的丢了，查数据链路`);
    for (const g of gaps.slice(-3)) {
      console.log(`      ${hhmmss(g.ts)} 期望 ${n(g.expected)} 收到 ${n(g.got)}，缺 ${n(g.missing)} 帧`);
    }
  }
  const ends = drops.filter((d) => d.phase === "end");
  if (drops.length) {
    const f = ends.reduce((s, d) => s + (n(d.frames) ?? 0), 0);
    const b = ends.reduce((s, d) => s + (n(d.bytes) ?? 0), 0);
    console.log(`  ⚠ 背压丢帧：${drops.filter((d) => d.phase === "start").length} 轮，累计 ${f} 帧 / ${b} 字节`);
  }

  // 步骤 3：核心判定
  const bad = screens.filter((s) => (n(s.missingLines) ?? 0) > 0);
  if (screens.length === 0) {
    console.log(`  · 无屏幕对拍记录（会话可能一直没有流式输出）`);
  } else if (bad.length === 0) {
    console.log(`  ✓ 屏幕对拍 ${screens.length} 次，均无缺行 —— buffer 与 tmux 一致`);
  } else {
    console.log(`  ✗ 屏幕对拍 ${screens.length} 次，其中 ${bad.length} 次有缺行 —— **buffer 真的少了内容，查写入路径**`);
    for (const s of bad.slice(-5)) {
      console.log(`      ${hhmmss(s.ts)} tmux=${n(s.tmuxLines)} xterm=${n(s.xtermLines)} 缺 ${n(s.missingLines)} 行（首个在第 ${n(s.firstDiff)} 行）陈旧 ${n(s.extraLines)} 行`);
    }
  }

  // 步骤 4/5：写入与渲染是否匹配
  // renderFrames=0 且同时段有字节 ⇒ 渲染器没动。注意**首条**心跳的 renderFrames
  // 是「从挂载至今」的累计，为 0 才真的意味着一次都没画过。
  const stalled = renders.filter((r) => (n(r.renderFrames) ?? -1) === 0);
  const wroteWhileStalled = stalled.filter((r) => {
    const w = writes.find((x) => Math.abs(Date.parse(x.ts) - Date.parse(r.ts)) < 2000);
    return w && (n(w.wroteBytes) ?? 0) > 0;
  });
  // 【2026-08-23】先排除「埋点自己死了」再谈渲染器停摆。同一条 render 记录里
  // 带着图集的 pageVersions —— 那是 WebGL 侧独立累加的版本号，与 onRender 订阅
  // 无关。renderFrames=0 而 pageVersions 在涨，说明屏幕明明在画、是订阅掉了，
  // 不是渲染器停了。线上 aippt 就是这样被误判成「停摆 5 次」的：清理写在了
  // onResize 里，窗口一改尺寸订阅就被永久退掉。
  //
  // 这是同一个教训的第二次：任何「计数恒为 0」都要先怀疑埋点，再怀疑被测对象。
  const versionSum = (r: Rec): number => {
    const v = r.pageVersions;
    return Array.isArray(v) ? v.reduce((a: number, x: unknown) => a + (typeof x === "number" ? x : 0), 0) : -1;
  };
  const climbing = wroteWhileStalled.filter((r, i) => {
    const prev = wroteWhileStalled[i - 1];
    return prev && versionSum(r) > versionSum(prev) && versionSum(prev) >= 0;
  });
  if (climbing.length) {
    console.log(`  ⚠ renderFrames=0 但图集版本号在涨 ${climbing.length} 次 —— 是 onRender 订阅掉了，不是渲染器停摆`);
    console.log(`      ⇒ 先查 Terminal.svelte 里 unsubscribeRender 的清理时机（应在 teardown，不在 onResize）`);
  } else if (wroteWhileStalled.length) {
    console.log(`  ✗ 渲染器停摆 ${wroteWhileStalled.length} 次：字节在涨但 renderFrames=0`);
    for (const r of wroteWhileStalled.slice(-5)) {
      const b = (k: string) => (typeof r[k] === "boolean" ? (r[k] ? "是" : "否") : "?");
      console.log(`      ${hhmmss(r.ts)} 暂停=${b("paused")} 渲染器在=${b("rendererSet")} 欠全量重画=${b("needsFullRefresh")} DOM可见=${b("domVisible")}`);
    }
    // 分支结论：xterm 的 _onRender.fire 前有两道闸（RenderService.refreshRows 的
    // _isPaused、_renderRows 的 _renderer.value），这里直接指出是哪一道。
    const pausedVisible = wroteWhileStalled.filter((r) => r.paused === true && r.domVisible === true);
    const noRenderer = wroteWhileStalled.filter((r) => r.rendererSet === false);
    if (pausedVisible.length) {
      console.log(`      ⇒ ${pausedVisible.length} 次「DOM 可见却仍处于暂停」——xterm 的 IntersectionObserver 没把暂停解除，查可见性恢复路径`);
    }
    if (noRenderer.length) {
      console.log(`      ⇒ ${noRenderer.length} 次渲染器指针为空——查 webgl-renderer 的 suspend/resume`);
    }
    if (!pausedVisible.length && !noRenderer.length && wroteWhileStalled.some((r) => r.paused === undefined)) {
      console.log(`      ⇒ 该样本无渲染服务状态字段（埋点早于 2026-08-22 第二批），下次复现才有`);
    }
  }
  // bufDelta = -1 是「首次采样、还没有基线」，不是「零增长」。把它当异常会让每个
  // 会话的第一条心跳都报一次假警。
  const odd = writes.filter((w) => (n(w.wroteBytes) ?? 0) > 4096 && (n(w.bufDelta) ?? -1) === 0);
  if (odd.length) {
    console.log(`  ⚠ ${odd.length} 次采样：写入 >4KB 但 buffer 行数零增长（可能是原地重绘，也可能是没落进 buffer）`);
  }

  // 重灌净损失（2026-08-23）。**这是屏幕对拍看不见的那条丢失路径**：
  // 对拍只哈希可视区 27 行，而 RIS 清的是整个 buffer（含 scrollback），
  // 损失全发生在屏幕之外，所以 missingLines 会一直是 0。
  //
  // bufferLenAfter < bufferLenBefore 就是净损失行数，直接读得出来 —— 这些数字
  // 在日志里躺了一整天没人看，因为脚本压根没解析 reseed 记录。埋点采到了不等于
  // 有人在读；判定脚本没覆盖的字段等于没埋。
  const reseeds = rs.filter((r) => r.kind === "reseed");
  const shrank = reseeds
    .map((r) => ({ r, before: n(r.bufferLenBefore) ?? 0, after: n(r.bufferLenAfter) ?? 0 }))
    .filter((x) => x.before > 0 && x.after > 0 && x.after < x.before);
  if (shrank.length) {
    const worst = shrank.reduce((a, b) => (b.before - b.after > a.before - a.after ? b : a));
    console.log(`  ✗ 重灌净损失 ${shrank.length} 次：buffer 行数不增反减 —— scrollback 被 RIS 抹掉且没回写`);
    for (const x of shrank.slice(-5)) {
      console.log(`      ${hhmmss(x.r.ts)} trigger=${String(x.r.trigger)} ${x.before} → ${x.after} 行（净损失 ${x.before - x.after}）`);
    }
    console.log(`      ⇒ 最严重一次损失 ${worst.before - worst.after} 行。查 reseedLines：拉的行数必须 >= 重灌前的 buffer 长度`);
  }

  // resize 与屏幕缺行的时间相关性（2026-08-24）。用户报告「终端在输出的时候
  // 我没有进行任何操作」，所以这里要回答的不是「有没有 resize」，而是
  // **「没人操作时有没有 resize，且它是否紧挨着缺行」**。
  //
  // why=activate 是切 tab 必发的（lastSentCols=-1 强制下发），单独排除，
  // 否则它会把真正要找的信号淹掉。
  const resizes = rs.filter((r) => r.kind === "resize");
  const spontaneous = resizes.filter((r) => r.why !== "activate");
  if (spontaneous.length) {
    console.log(`  ⚠ 非激活类 resize ${spontaneous.length} 次（没人切 tab 也发生了尺寸变化）`);
    for (const r of spontaneous.slice(-5)) {
      console.log(`      ${hhmmss(r.ts)} why=${String(r.why)} ${n(r.fromCols) ?? "?"}×${n(r.fromRows) ?? "?"} → ${n(r.toCols) ?? "?"}×${n(r.toRows) ?? "?"}`);
    }
    // 与缺行的时间相关：30s 内同时出现即高度可疑
    const near = bad.filter((b) =>
      spontaneous.some((r) => Math.abs(Date.parse(r.ts) - Date.parse(b.ts)) < 30_000));
    if (near.length) {
      console.log(`      ⇒ 其中 ${near.length} 次缺行发生在 resize 后 30s 内 —— 高度怀疑 resize 重排与流式输出叠加`);
    } else {
      console.log(`      ⇒ 但没有一次缺行落在 resize 附近 —— resize 与本次缺行无关，别顺着它查`);
    }
  } else if (bad.length) {
    console.log(`  ⚠ 本时段没有任何非激活类 resize —— 缺行**不是** resize 引起的`);
  }

  // 一句话结论
  const verdict = shrank.length > 0
    ? "重灌把 scrollback 抹短了 ⇒ 历史丢失（对拍看不见）"
    : bad.length > 0
    ? "buffer 缺内容 ⇒ 数据/写入路径"
    : wroteWhileStalled.length > 0
      ? "buffer 完好但没画 ⇒ 渲染器"
      : gaps.length || drops.length
        ? "有丢帧但屏幕已自愈（reseed/resync 补上了）"
        : "本时段未见异常";
  console.log(`  ⇒ ${verdict}\n`);
}
