import { test, expect } from "bun:test";
import { formatDiagReport, DIAG_PREFIX, diagEnabled } from "./diag-report";

const at = () => Date.parse("2026-08-01T10:00:00.000Z");

function parse(line: string) {
  expect(line.startsWith(DIAG_PREFIX + " ")).toBe(true);
  return JSON.parse(line.slice(DIAG_PREFIX.length + 1));
}

test("keeps the atlas fields that identify the bug", () => {
  const o = parse(formatDiagReport({
    tag: "claude-1",
    kind: "atlas",
    hasRenderer: true,
    pages: 2,
    pageVersions: [7, 3],
    textureVersions: [7, 3],
    pagesBlank: [true, false],
    pageLayoutVersion: 4,
  }, at));
  expect(o.ts).toBe("2026-08-01T10:00:00.000Z");
  expect(o.tag).toBe("claude-1");
  expect(o.kind).toBe("atlas");
  expect(o.hasRenderer).toBe(true);
  expect(o.pages).toBe(2);
  expect(o.pageVersions).toEqual([7, 3]);
  expect(o.textureVersions).toEqual([7, 3]);
  expect(o.pagesBlank).toEqual([true, false]);
  expect(o.pageLayoutVersion).toBe(4);
});

// pagesBlank alone is ambiguous — a never-used page is blank too. These two are
// what tell "the pixels vanished" apart from "nothing was ever drawn", so a
// whitelist that drops them turns every report back into a guess.
test("keeps the fields that disambiguate a blank page", () => {
  const o = parse(formatDiagReport({
    tag: "t", kind: "atlas",
    pagesBlank: [true, true],
    pageGlyphs: [0, 812],
    pagesUsed: [false, true],
  }, at));
  expect(o.pageGlyphs).toEqual([0, 812]);
  expect(o.pagesUsed).toEqual([false, true]);
});

test("emits exactly one line so one report cannot forge another", () => {
  const line = formatDiagReport({ tag: "a\nb\r\nc", kind: "atlas", error: "x\ny" }, at);
  expect(line.includes("\n")).toBe(false);
  expect(line.includes("\r")).toBe(false);
});

// The whole point of a whitelist: a compromised or buggy client must not be
// able to write terminal contents (or anything else it chooses) into a log the
// user may later paste into a public issue.
test("drops every field that is not on the whitelist", () => {
  const o = parse(formatDiagReport({
    tag: "t", kind: "atlas",
    // things a client might send that we must never persist
    buffer: "sk-live-abcdef",
    cwd: "/Users/someone/secret-project",
    env: { TOKEN: "x" },
  }, at));
  expect(o.buffer).toBeUndefined();
  expect(o.cwd).toBeUndefined();
  expect(o.env).toBeUndefined();
});

test("rejects non-numeric and non-boolean array members instead of echoing them", () => {
  const o = parse(formatDiagReport({
    tag: "t", kind: "atlas",
    pageVersions: [1, "leak", null, 2],
    pagesBlank: [true, "leak", 1],
  }, at));
  expect(o.pageVersions).toEqual([1, 0, 0, 2]);
  expect(o.pagesBlank).toEqual([true, false, false]);
});

test("caps unbounded input so a client cannot flood the log", () => {
  const o = parse(formatDiagReport({
    tag: "x".repeat(500),
    kind: "atlas",
    pageVersions: Array.from({ length: 500 }, (_, i) => i),
    error: "e".repeat(5000),
  }, at));
  expect(o.tag.length).toBeLessThanOrEqual(64);
  expect(o.pageVersions.length).toBeLessThanOrEqual(64);
  expect(o.error.length).toBeLessThanOrEqual(200);
});

test("survives junk input rather than throwing into the rpc handler", () => {
  for (const junk of [undefined, null, 42, "str", [], { tag: {} }]) {
    const line = formatDiagReport(junk as unknown, at);
    expect(line.startsWith(DIAG_PREFIX)).toBe(true);
    expect(() => parse(line)).not.toThrow();
  }
});

test("marks an unknown kind rather than trusting the client's label", () => {
  const o = parse(formatDiagReport({ tag: "t", kind: "whatever" }, at));
  expect(o.kind).toBe("unknown");
});

// 需求 3（12 期）：滚动状态快照。白名单制意味着不显式加进去的字段会被静默
// 丢掉——那样埋点会「看起来接好了」但日志里什么都没有，是最难发现的失效。
test("keeps the scroll fields that identify a stuck viewport", () => {
  const o = parse(formatDiagReport({
    tag: "sess-1",
    kind: "scroll",
    bufferType: "normal",
    bufferLength: 500,
    baseY: 476,
    ydisp: 476,
    rows: 24,
    cols: 80,
    cellHeight: 0,
    canvasHeight: 408,
    scrollHeight: 0,
    scrollTop: 0,
    clientHeight: 408,
  }, at));
  expect(o.kind).toBe("scroll");
  expect(o.bufferType).toBe("normal");
  expect(o.bufferLength).toBe(500);
  expect(o.baseY).toBe(476);
  expect(o.ydisp).toBe(476);
  expect(o.rows).toBe(24);
  expect(o.cols).toBe(80);
  expect(o.cellHeight).toBe(0);
  expect(o.canvasHeight).toBe(408);
  expect(o.scrollHeight).toBe(0);
  expect(o.scrollTop).toBe(0);
  expect(o.clientHeight).toBe(408);
});

// -1（读不到）与 0（真的塌陷）必须都原样保留 —— 把 -1 归一成 0 会让日志
// 读出完全相反的结论。
test("keeps -1 and 0 apart in a scroll report", () => {
  const o = parse(formatDiagReport({
    tag: "t", kind: "scroll", cellHeight: -1, scrollHeight: 0,
  }, at));
  expect(o.cellHeight).toBe(-1);
  expect(o.scrollHeight).toBe(0);
});

// bufferType 是客户端来的字符串，同样要过净化与长度上限。
test("sanitises bufferType like every other client string", () => {
  const o = parse(formatDiagReport({
    tag: "t", kind: "scroll", bufferType: "x".repeat(500) + "\nforged",
  }, at));
  expect(o.bufferType.includes("\n")).toBe(false);
  expect(o.bufferType.length).toBeLessThanOrEqual(64);
});

// 重灌历史的诊断（2026-08-08）。同样是白名单制：不显式加进去的字段会被静默
// 丢掉，日志里只是少几个数、什么都不报错，是最难发现的失效。
test("reseed 诊断：kind 被接受，计数字段原样带上", () => {
  const line = formatDiagReport({
    tag: "sess-1", kind: "reseed", trigger: "alt-normal",
    rttMs: 120, discarded: true, snapshotBytes: 4096,
    framesDuringAwait: 3, bytesDuringAwait: 800,
    bufferLenBefore: 500, bufferLenAfter: 480,
  });
  const body = JSON.parse(line.slice(DIAG_PREFIX.length + 1));
  expect(body.kind).toBe("reseed");
  expect(body.trigger).toBe("alt-normal");
  expect(body.rttMs).toBe(120);
  expect(body.discarded).toBe(true);
  expect(body.bufferLenAfter).toBe(480);
});

test("reseed 诊断：trigger 里的换行被抹平，不能伪造第二行日志", () => {
  const line = formatDiagReport({ kind: "reseed", trigger: "a\nFAKE" });
  expect(line.split("\n").length).toBe(1);
});

test("reseed recovery scheduling metadata survives without terminal content", () => {
  const body = parse(formatDiagReport({
    kind: "reseed", mode: "online", queued: true, liveBytes: 8192,
    snapshot: "SECRET-SNAPSHOT", text: "SECRET-TEXT", data: "SECRET-DATA",
  }, at));
  expect(body).toMatchObject({
    kind: "reseed", mode: "online", queued: true, liveBytes: 8192,
  });
  expect(JSON.stringify(body)).not.toContain("SECRET");
});

test("stream-policy accepts bounded identifiers and content-free counters", () => {
  const body = parse(formatDiagReport({
    kind: "stream-policy",
    current: "current\nforged" + "x".repeat(100),
    grace: "grace\tforged",
    streamingCount: 2,
    detachedCount: 1,
    snapshot: "SECRET-SNAPSHOT",
    text: "SECRET-TEXT",
  }, at));
  expect(body.kind).toBe("stream-policy");
  expect(body.current).not.toContain("\n");
  expect(body.current.length).toBeLessThanOrEqual(64);
  expect(body.grace).toBe("grace forged");
  expect(body.streamingCount).toBe(2);
  expect(body.detachedCount).toBe(1);
  expect(JSON.stringify(body)).not.toContain("SECRET");
});

test("stream-policy preserves absent current and grace as null", () => {
  expect(parse(formatDiagReport({
    kind: "stream-policy", current: null, grace: null,
  }, at))).toMatchObject({ kind: "stream-policy", current: null, grace: null });
});

test("kind rpc keeps the five wire counters and drops everything else", () => {
  const line = formatDiagReport({
    kind: "rpc", tag: "t", method: "fs.read", rttMs: 820,
    wireBytes: 34188, rawBytes: 65695, chunks: 1,
    secret: "should not appear", content: "neither should this",
  }, () => 0);
  const obj = JSON.parse(line.slice(DIAG_PREFIX.length).trim());
  expect(obj.kind).toBe("rpc");
  expect(obj.method).toBe("fs.read");
  expect(obj.rttMs).toBe(820);
  expect(obj.wireBytes).toBe(34188);
  expect(obj.rawBytes).toBe(65695);
  expect(obj.chunks).toBe(1);
  expect(obj.secret).toBeUndefined();
  expect(obj.content).toBeUndefined();
});

test("kind rpc method is sanitised to one line and bounded", () => {
  const line = formatDiagReport({ kind: "rpc", method: "a\nb\tc" + "x".repeat(200) }, () => 0);
  const obj = JSON.parse(line.slice(DIAG_PREFIX.length).trim());
  expect(obj.method).not.toContain("\n");
  expect(obj.method.length).toBeLessThanOrEqual(64);
});

// 【2026-08-22 全链路埋点】新增 kind 与字段的白名单复核。这些日志用户可能直接
// 贴进公开 issue，所以「不含终端内容」是硬约束，不是风格问题。
const p2 = (o: unknown) => parse(formatDiagReport(o, at));

test("四个新 kind 都被接受，不再落成 unknown", () => {
  for (const k of ["drop", "screen", "write", "render"]) {
    expect(p2({ tag: "s", kind: k }).kind).toBe(k);
  }
});

test("screen: 只留统计，终端内容与行文本一律丢弃", () => {
  const out = p2({
    tag: "s", kind: "screen", phase: "stream",
    tmuxLines: 26, xtermLines: 27, missingLines: 2, extraLines: 1, firstDiff: 5,
    lines: ["机密内容", "另一行"], text: "不该出现", hashes: [1, 2, 3],
  });
  expect(out).toMatchObject({ tmuxLines: 26, xtermLines: 27, missingLines: 2, extraLines: 1, firstDiff: 5, phase: "stream" });
  expect(out.lines).toBeUndefined();
  expect(out.text).toBeUndefined();
  expect(out.hashes).toBeUndefined();
});

test("drop: 起始/结算两种形态都留得下", () => {
  expect(p2({ tag: "s", kind: "drop", phase: "start", buffered: 1048577 }))
    .toMatchObject({ phase: "start", buffered: 1048577 });
  expect(p2({ tag: "s", kind: "drop", phase: "end", frames: 12, bytes: 3400, durMs: 900 }))
    .toMatchObject({ phase: "end", frames: 12, bytes: 3400, durMs: 900 });
});

test("seqgap: expected/got/missing 三个专名", () => {
  expect(p2({ tag: "s", kind: "seqgap", expected: 100, got: 105, missing: 4 }))
    .toMatchObject({ expected: 100, got: 105, missing: 4 });
});

test("write / render: 计数字段留得下", () => {
  expect(p2({ tag: "s", kind: "write", wroteFrames: 30, wroteBytes: 9000, bufDelta: 12, sinceMs: 15000 }))
    .toMatchObject({ wroteFrames: 30, wroteBytes: 9000, bufDelta: 12, sinceMs: 15000 });
  expect(p2({ tag: "s", kind: "render", renderFrames: 0, dirtyRows: 0, sinceMs: 15000 }))
    .toMatchObject({ renderFrames: 0, dirtyRows: 0, sinceMs: 15000 });
});

test("0 与 -1 必须原样保留: 0=真的没画, -1=读不到", () => {
  const out = p2({ tag: "s", kind: "render", renderFrames: 0, dirtyRows: 0 });
  expect(out.renderFrames).toBe(0);
  expect(out.dirtyRows).toBe(0);
  expect(p2({ tag: "s", kind: "screen", firstDiff: -1 }).firstDiff).toBe(-1);
});

test("phase 同样过 oneLine, 换行不能伪造新日志行", () => {
  expect(p2({ tag: "s", kind: "drop", phase: "a\nb" }).phase).toBe("a b");
});

test("render: 渲染服务状态四个布尔留得下", () => {
  expect(p2({ tag: "s", kind: "render", paused: true, rendererSet: false, needsFullRefresh: true, domVisible: true }))
    .toMatchObject({ paused: true, rendererSet: false, needsFullRefresh: true, domVisible: true });
});

test("render: 「读不到」不能被伪装成 false —— 缺席就该缺席", () => {
  const out = p2({ tag: "s", kind: "render", paused: "yes", rendererSet: 1 });
  expect(out.paused).toBeUndefined();
  expect(out.rendererSet).toBeUndefined();
});

// 【2026-08-28 三件套】写泵看门狗与全局 JS 异常取证。两端字段名逐字对应：
// app/src/lib/term/write-pump.ts（PumpSnapshot/PumpKickResult）与
// app/src/lib/js-error-hook.ts（JsErrorReport）。漂移是静默的，所以这里钉住。
test("pump-kick: kind 白名单认得，滞留量与解析器状态留得下", () => {
  expect(p2({ tag: "s", kind: "pump-kick" }).kind).toBe("pump-kick");
  const out = p2({
    tag: "s", kind: "pump-kick", phase: "watchdog",
    wroteBytes: 4096, wbPending: 4096, wbStuck: 3, wbOffset: 17, parserState: 1,
    parsePaused: true, kicked: true, unreadable: false, parserReset: true,
  });
  expect(out).toMatchObject({
    wroteBytes: 4096, wbPending: 4096, wbStuck: 3, wbOffset: 17, parserState: 1,
    parsePaused: true, kicked: true, unreadable: false, parserReset: true,
  });
});

test("pump-kick: 「读不到」不能变成 0/false", () => {
  const out = p2({ tag: "s", kind: "pump-kick", wbStuck: "3", parsePaused: 1, parserReset: undefined });
  expect(out.wbStuck).toBeUndefined();
  expect(out.parsePaused).toBeUndefined();
  expect(out.parserReset).toBeUndefined();
});

test("js-error: kind 白名单认得，message/stack/source 单行化留得下", () => {
  expect(p2({ tag: "app", kind: "js-error" }).kind).toBe("js-error");
  const out = p2({
    tag: "app", kind: "js-error",
    error: "boom\nat somewhere", stack: "Error: boom\n  at x.ts:1:1", source: "https://x/app.js:1:2",
  });
  expect(out.error).toBe("boom at somewhere");
  expect(out.stack).toBe("Error: boom   at x.ts:1:1");
  expect(out.source).toBe("https://x/app.js:1:2");
});

test("js-error: 栈截断到 1500, 超长的部分进不了日志", () => {
  const out = p2({ tag: "app", kind: "js-error", stack: "s".repeat(5000) });
  expect(out.stack.length).toBe(1500);
});

// 诊断总开关（2026-08-23）。默认关闭，环境变量优先于 agent.json。
test("diagEnabled: 默认关闭", () => {
  expect(diagEnabled({})).toBe(false);
  expect(diagEnabled({}, undefined)).toBe(false);
  expect(diagEnabled({}, false)).toBe(false);
});

test("diagEnabled: agent.json 的 diag=true 能开", () => {
  expect(diagEnabled({}, true)).toBe(true);
});

test("diagEnabled: 环境变量各种真值", () => {
  for (const v of ["1", "true", "on", "yes", "TRUE", " On "]) {
    expect(diagEnabled({ POCKETSHELL_DIAG: v })).toBe(true);
  }
});

test("diagEnabled: 环境变量的显式假值压过 agent.json 的 true —— 否则没法临时关", () => {
  for (const v of ["0", "false", "off", "no"]) {
    expect(diagEnabled({ POCKETSHELL_DIAG: v }, true)).toBe(false);
  }
});

test("diagEnabled: 空字符串视为未设置，回落到 agent.json", () => {
  expect(diagEnabled({ POCKETSHELL_DIAG: "" }, true)).toBe(true);
  expect(diagEnabled({ POCKETSHELL_DIAG: "" }, false)).toBe(false);
});

test("diagEnabled: 认不出的值当作关（不能把 'maybe' 读成开）", () => {
  expect(diagEnabled({ POCKETSHELL_DIAG: "maybe" }, false)).toBe(false);
});
