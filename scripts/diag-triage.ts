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

  // 一句话结论
  const verdict = bad.length > 0
    ? "buffer 缺内容 ⇒ 数据/写入路径"
    : wroteWhileStalled.length > 0
      ? "buffer 完好但没画 ⇒ 渲染器"
      : gaps.length || drops.length
        ? "有丢帧但屏幕已自愈（reseed/resync 补上了）"
        : "本时段未见异常";
  console.log(`  ⇒ ${verdict}\n`);
}
