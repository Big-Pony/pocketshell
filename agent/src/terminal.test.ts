import { test, expect } from "bun:test";
import { TerminalService, type TmuxResult, type TmuxRunner } from "./terminal";
import { StateHysteresis } from "./state";

const utf8 = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));
const ok = (s = "") => ({ exitCode: 0, stdout: utf8(s), stderr: new Uint8Array() });
const fail = () => ({ exitCode: 1, stdout: new Uint8Array(), stderr: new Uint8Array() });

// Fake tmux: answers list-sessions / capture-pane / has-session from a map,
// and (optionally) records every argv for command-issued assertions.
export function fakeTmux(
  map: { list?: string; capture?: Record<string, string> },
  calls?: string[][],
): TmuxRunner {
  return (args) => {
    calls?.push(args);
    // Match by subcommand, not args[0]: real calls prefix a global `-u` flag.
    if (args.includes("list-sessions")) return map.list != null ? ok(map.list) : fail();
    if (args.includes("capture-pane")) {
      const name = args[args.indexOf("-t") + 1];
      return ok(map.capture?.[name] ?? "");
    }
    if (args.includes("has-session")) return ok();
    return ok();
  };
}

test("list() surfaces foreign tmux sessions as idle + attached:false", async () => {
  const term = new TerminalService({
    tmux: fakeTmux({
      list: "work\t1700000000\t120\t40\nbuild\t1700000100\t80\t24\n",
      capture: { work: "$ vim main.ts", build: "npm run build" },
    }),
  });
  const sessions = await term.list();
  term.dispose();

  expect(sessions).toHaveLength(2);
  const work = sessions.find((s) => s.name === "work")!;
  expect(work.state).toBe("idle");
  expect(work.attached).toBe(false);
  expect(work.cols).toBe(120);
  expect(work.rows).toBe(40);
  expect(work.createdAt).toBe(1700000000 * 1000);
  expect(work.lastLine).toBe("$ vim main.ts");
});

test("list() tolerates a missing/failing tmux (roster query) -> empty", async () => {
  const term = new TerminalService({ tmux: () => fail() });
  expect(await term.list()).toEqual([]);
  term.dispose();
});

test("roster + previews force tmux UTF-8 (-u) so launchd's C locale can't sanitize tab delimiters to _", async () => {
  const calls: string[][] = [];
  const term = new TerminalService({
    tmux: fakeTmux({ list: "work\t1700000000\t80\t24\n", capture: { work: "hi" } }, calls),
  });
  await term.list();
  term.dispose();
  // Both output-parsed commands must lead with the global -u flag.
  const ls = calls.find((a) => a.includes("list-sessions"))!;
  const cap = calls.find((a) => a.includes("capture-pane"))!;
  expect(ls[0]).toBe("-u");
  expect(cap[0]).toBe("-u");
});

test("rename() renames a foreign (non-owned) session instead of no-op", () => {
  const calls: string[][] = [];
  const term = new TerminalService({ tmux: fakeTmux({ list: "" }, calls) });
  term.rename("old", "shiny");
  term.dispose();
  expect(calls).toContainEqual(["rename-session", "-t", "old", "shiny"]);
});

test("history() exports full pane scrollback + visible area with colours (base64)", async () => {
  const calls: string[][] = [];
  const term = new TerminalService({
    tmux: (args) => {
      calls.push(args);
      if (args[0] === "display-message") return ok("0\n"); // alternate_on = 0
      if (args.includes("capture-pane")) return ok("\x1b[36mLINE_1\x1b[39m\nLINE_2");
      return ok();
    },
  });
  const r = await term.history("work", 0);
  expect(Buffer.from(r.data, "base64").toString("utf8")).toBe("\x1b[36mLINE_1\x1b[39m\nLINE_2");
  const cap = calls.find((a) => a.includes("capture-pane"))!;
  expect(cap).toEqual(["-u", "capture-pane", "-e", "-p", "-J", "-S", "-", "-E", "-", "-t", "work"]);
  term.dispose();
});

test("history() 透传调用方给的 seq，并保持 capture 参数不变", async () => {
  const calls: string[][] = [];
  const term = new TerminalService({
    tmux: (args) => {
      calls.push(args);
      if (args.includes("capture-pane")) return ok("\x1b[36mLINE_1\x1b[39m\nLINE_2");
      return ok();
    },
  });
  const r = await term.history("work", 42);
  expect(r.seq).toBe(42);
  expect(Buffer.from(r.data, "base64").toString("utf8")).toBe("\x1b[36mLINE_1\x1b[39m\nLINE_2");
  const cap = calls.find((a) => a.includes("capture-pane"))!;
  expect(cap).toEqual(["-u", "capture-pane", "-e", "-p", "-J", "-S", "-", "-E", "-", "-t", "work"]);
  term.dispose();
});

test("history() 在 capture 失败时仍返回完整形状（seq 不丢）", async () => {
  // seq 丢了会让前端 attach(undefined) 退化成 attach(0)，把整个 replay 缓冲
  // 重放一遍——正是这次要消灭的双重渲染。所以失败路径也必须带上 seq。
  const term = new TerminalService({ tmux: () => fail() });
  expect(await term.history("gone", 7)).toEqual({ data: "", seq: 7 });
  term.dispose();
});

test("history() captures the pane even when alternate_on is set", async () => {
  const term = new TerminalService({
    tmux: (args) => (args.includes("capture-pane") ? ok("ALT_LINE") : ok("1")),
  });
  expect((await term.history("vim", 0)).data).toBe(Buffer.from("ALT_LINE").toString("base64"));
  term.dispose();
});

// ---- capture(): 复制路径用的纯文本导出（任务2/3）----
// 实测（tmux 3.6b）：capture-pane 不带 -e 输出就是干净纯文本，一个 SGR 转义
// 都没有；带 -e 才有颜色。复制要的是可粘贴的文本，所以走不带 -e 的那条。

test("capture() 默认不带 -e —— 复制路径要纯文本，不能夹 SGR 转义", async () => {
  const calls: string[][] = [];
  const term = new TerminalService({
    tmux: (args) => { calls.push(args); return ok("PLAIN_1\nPLAIN_2"); },
  });
  const r = await term.capture("work");
  expect(Buffer.from(r.data, "base64").toString("utf8")).toBe("PLAIN_1\nPLAIN_2");
  const cap = calls.find((a) => a.includes("capture-pane"))!;
  expect(cap).not.toContain("-e");
  expect(cap).toEqual(["-u", "capture-pane", "-p", "-J", "-S", "-", "-E", "-", "-t", "work"]);
  term.dispose();
});

test("capture({colors:true}) 才加 -e —— 首屏 seed 仍要颜色", async () => {
  const calls: string[][] = [];
  const term = new TerminalService({
    tmux: (args) => { calls.push(args); return ok("X"); },
  });
  await term.capture("work", { colors: true });
  const cap = calls.find((a) => a.includes("capture-pane"))!;
  expect(cap).toEqual(["-u", "capture-pane", "-e", "-p", "-J", "-S", "-", "-E", "-", "-t", "work"]);
  term.dispose();
});

// back 是「光标往上第几行」，由 tmux 自己的 #{cursor_y} 解析成 -S。
// 不能让前端直接传绝对行号：xterm 的 baseY 与 tmux 的可见区顶行不同源
// （实测同一个 pane，xterm cursorY=23 而 tmux cursor_y=3），绝对行号会切错段。
test("capture({back}) 用 tmux 自己的 cursor_y 解析成 -S（cursor_y - back）", async () => {
  const calls: string[][] = [];
  const term = new TerminalService({
    tmux: (args) => {
      calls.push(args);
      if (args[0] === "display-message") return ok("23\n");
      return ok("OUT");
    },
  });
  await term.capture("work", { back: 41 });
  const cap = calls.find((a) => a.includes("capture-pane"))!;
  expect(cap[cap.indexOf("-S") + 1]).toBe("-18"); // 23 - 41
  term.dispose();
});

test("capture({back}) 屏幕没滚动时得到 0 或正数（不是所有情况都为负）", async () => {
  const calls: string[][] = [];
  const term = new TerminalService({
    tmux: (args) => {
      calls.push(args);
      if (args[0] === "display-message") return ok("3\n");
      return ok("OUT");
    },
  });
  await term.capture("work", { back: 3 });
  const cap = calls.find((a) => a.includes("capture-pane"))!;
  expect(cap[cap.indexOf("-S") + 1]).toBe("0");
  term.dispose();
});

test("capture({back}) 在 cursor_y 查询失败时退回全量（不瞎猜行号）", async () => {
  const calls: string[][] = [];
  const term = new TerminalService({
    tmux: (args) => {
      calls.push(args);
      if (args[0] === "display-message") return fail();
      return ok("OUT");
    },
  });
  await term.capture("work", { back: 5 });
  const cap = calls.find((a) => a.includes("capture-pane"))!;
  expect(cap[cap.indexOf("-S") + 1]).toBe("-");
  term.dispose();
});

test("capture({back}) 非整数/负数/越界一律退回全量 -S -（不把垃圾拼进 argv）", async () => {
  const calls: string[][] = [];
  const term = new TerminalService({
    tmux: (args) => { calls.push(args); return args[0] === "display-message" ? ok("10\n") : ok("OUT"); },
  });
  await term.capture("work", { back: Number.NaN });
  await term.capture("work", { back: 1.5 });
  await term.capture("work", { back: -1 });
  await term.capture("work", { back: Number.POSITIVE_INFINITY });
  await term.capture("work", { back: 9e9 });
  for (const cap of calls.filter((a) => a.includes("capture-pane"))) {
    expect(cap[cap.indexOf("-S") + 1]).toBe("-");
  }
  term.dispose();
});

test("capture() 不给 back 时不去查 cursor_y（少一次 spawn）", async () => {
  const calls: string[][] = [];
  const term = new TerminalService({
    tmux: (args) => { calls.push(args); return ok("OUT"); },
  });
  await term.capture("work");
  expect(calls.some((a) => a[0] === "display-message")).toBe(false);
  term.dispose();
});

test("capture() 失败返回空 data 而不是抛", async () => {
  const term = new TerminalService({ tmux: () => fail() });
  expect(await term.capture("gone")).toEqual({ data: "", atTop: true });
  term.dispose();
});

// ---- capture({back, endBack}): 复制模式的「上翻分页」----
// 实测 tmux 3.6b：`-S -50 -E -41` 恰好 10 行，`-S -100 -E -91` 是更早的 10 行，
// 两段无重叠可无缝拼接。endBack 与 back 同源（都是「光标往上第几行」），
// 区间闭合：覆盖 back - endBack + 1 行。

test("capture({back, endBack}) 把区间两端都解析成 -S/-E（不再固定 -E -）", async () => {
  const calls: string[][] = [];
  const term = new TerminalService({
    tmux: (args) => {
      calls.push(args);
      if (args[0] === "display-message") return ok("23|500\n");
      return ok("OUT");
    },
  });
  await term.capture("work", { back: 400, endBack: 201 });
  const cap = calls.find((a) => a.includes("capture-pane"))!;
  expect(cap[cap.indexOf("-S") + 1]).toBe("-377"); // 23 - 400
  expect(cap[cap.indexOf("-E") + 1]).toBe("-178"); // 23 - 201
  term.dispose();
});

test("capture() 不给 endBack 时 -E 仍是 -（底部）—— 老调用方不回归", async () => {
  const calls: string[][] = [];
  const term = new TerminalService({
    tmux: (args) => {
      calls.push(args);
      if (args[0] === "display-message") return ok("23|500\n");
      return ok("OUT");
    },
  });
  await term.capture("work", { back: 41 });
  const cap = calls.find((a) => a.includes("capture-pane"))!;
  expect(cap[cap.indexOf("-E") + 1]).toBe("-");
  term.dispose();
});

// atTop 必须由后端算：tmux 的 `-J` 会把折行接成一行，返回的**行数少于请求的行数**
// （实测 40 列 pane 请求 6 行、-J 后只有 4 行），所以前端无法用「行数不足 200」
// 判断到顶。越过顶部时 tmux 也不报错、不返回空行，而是**钳位重发最老那一行**
// （实测 hist=379 时 -S -900 与 -S -379 返回同一行），前端据此判断会拿到重复内容。
test("capture() 用 history_size 判定是否已到历史顶部（前端无法从行数推断）", async () => {
  const term = new TerminalService({
    tmux: (args) => (args[0] === "display-message" ? ok("23|379\n") : ok("OUT")),
  });
  // -S = 23 - 300 = -277，比最老行 -379 新 → 还有更早的
  expect((await term.capture("work", { back: 300, endBack: 101 })).atTop).toBe(false);
  // -S = 23 - 402 = -379，正好是最老一行 → 到顶
  expect((await term.capture("work", { back: 402, endBack: 203 })).atTop).toBe(true);
  term.dispose();
});

test("capture() 整段都在历史顶部之外时返回空，不让 tmux 钳位出重复行", async () => {
  const term = new TerminalService({
    tmux: (args) => (args[0] === "display-message" ? ok("23|379\n") : ok("OLDEST_LINE")),
  });
  // -E = 23 - 500 = -477，已在最老行 -379 之上 → 整段不存在
  const r = await term.capture("work", { back: 699, endBack: 500 });
  expect(r).toEqual({ data: "", atTop: true });
  term.dispose();
});

test("capture() 全量（不给 back）就是到顶的定义 —— atTop 为真", async () => {
  const term = new TerminalService({ tmux: () => ok("OUT") });
  expect((await term.capture("work")).atTop).toBe(true);
  term.dispose();
});

test("capture({endBack}) 非法值（非整数/负数/大于 back）退化为 -E -，不拼垃圾进 argv", async () => {
  const calls: string[][] = [];
  const term = new TerminalService({
    tmux: (args) => { calls.push(args); return args[0] === "display-message" ? ok("23|500\n") : ok("OUT"); },
  });
  await term.capture("work", { back: 100, endBack: Number.NaN });
  await term.capture("work", { back: 100, endBack: 1.5 });
  await term.capture("work", { back: 100, endBack: -1 });
  await term.capture("work", { back: 100, endBack: 101 }); // 终点比起点还早
  for (const cap of calls.filter((a) => a.includes("capture-pane"))) {
    expect(cap[cap.indexOf("-E") + 1]).toBe("-");
  }
  term.dispose();
});

test("capture({endBack}) 在 back 无效时一并忽略（区间无起点就没有区间）", async () => {
  const calls: string[][] = [];
  const term = new TerminalService({
    tmux: (args) => { calls.push(args); return args[0] === "display-message" ? ok("23|500\n") : ok("OUT"); },
  });
  await term.capture("work", { back: -5, endBack: 10 });
  const cap = calls.find((a) => a.includes("capture-pane"))!;
  expect(cap[cap.indexOf("-S") + 1]).toBe("-");
  expect(cap[cap.indexOf("-E") + 1]).toBe("-");
  term.dispose();
});

test("history() 仍是带颜色的全量 capture（委托 capture 后行为不变）", async () => {
  const calls: string[][] = [];
  const term = new TerminalService({
    tmux: (args) => { calls.push(args); return ok("H"); },
  });
  const r = await term.history("work", 9);
  expect(r.seq).toBe(9);
  const cap = calls.find((a) => a.includes("capture-pane"))!;
  expect(cap).toEqual(["-u", "capture-pane", "-e", "-p", "-J", "-S", "-", "-E", "-", "-t", "work"]);
  term.dispose();
});

test("paneInfo() reports current command and alternate-screen state", () => {
  const term = new TerminalService({
    tmux: (args) => (args[0] === "display-message" ? ok("vim|1") : ok()),
  });
  expect(term.paneInfo("vim")).toEqual({ currentCommand: "vim", alternateOn: true, isShell: false });
  term.dispose();
});

test("paneInfo() recognizes common shells", () => {
  const term = new TerminalService({
    tmux: (args) => (args[0] === "display-message" ? ok("zsh|1") : ok()),
  });
  expect(term.paneInfo("shell")).toEqual({ currentCommand: "zsh", alternateOn: true, isShell: true });
  term.dispose();
});

test("paneInfo() returns a complete shape (incl. isShell) when tmux fails", () => {
  // A failing display-message must NOT drop isShell: the frontend reads it as a
  // boolean and an undefined would falsy-misclassify a shell as a full-screen app.
  const term = new TerminalService({ tmux: () => fail() });
  expect(term.paneInfo("gone")).toEqual({ currentCommand: "", alternateOn: false, isShell: false });
  term.dispose();
});

test("redraw() refreshes every client attached to the session", () => {
  const calls: string[][] = [];
  const term = new TerminalService({
    tmux: (args) => {
      calls.push(args);
      if (args.includes("list-clients")) return ok("/dev/ttys001\n/dev/ttys002\n");
      return ok();
    },
  });
  expect(term.redraw("work")).toEqual({ ok: true });
  term.dispose();
  expect(calls.find((a) => a.includes("list-clients"))).toEqual(
    ["list-clients", "-t", "work", "-F", "#{client_name}"],
  );
  expect(calls).toContainEqual(["refresh-client", "-t", "/dev/ttys001"]);
  expect(calls).toContainEqual(["refresh-client", "-t", "/dev/ttys002"]);
});

test("redraw() degrades gracefully when tmux fails or no client is attached", () => {
  const dead = new TerminalService({ tmux: () => fail() });
  expect(dead.redraw("gone")).toEqual({ ok: false });
  dead.dispose();

  const lonely = new TerminalService({
    tmux: (args) => (args.includes("list-clients") ? ok("\n") : ok()),
  });
  expect(lonely.redraw("detached")).toEqual({ ok: false });
  lonely.dispose();
});

test("pwd() returns the pane_current_path from tmux", () => {
  const term = new TerminalService({
    tmux: (args) => (args.includes("display-message") ? ok("/Users/me/proj\n") : ok()),
  });
  expect(term.pwd("s1")).toEqual({ pwd: "/Users/me/proj" });
  term.dispose();
});

test("pwd() returns empty pwd when tmux fails", () => {
  const term = new TerminalService({ tmux: () => fail() });
  expect(term.pwd("s1")).toEqual({ pwd: "" });
  term.dispose();
});

test("ensure() injects LANG at new-session when a locale fallback is configured", () => {
  const calls: string[][] = [];
  const term = new TerminalService({
    tmux: (args) => {
      calls.push(args);
      if (args.includes("has-session")) return fail(); // no existing session -> must create
      return ok();
    },
    langFallback: "en_US.UTF-8",
  });
  term.ensure("t-lang-fallback");
  term.dispose();

  const created = calls.find((a) => a.includes("new-session"))!;
  const eIdx = created.indexOf("LANG=en_US.UTF-8");
  expect(eIdx).toBeGreaterThan(0);
  expect(created[eIdx - 1]).toBe("-e"); // must be preceded by its own -e flag
});

test("ensure() does not inject LANG at new-session when there is no locale fallback", () => {
  const calls: string[][] = [];
  const term = new TerminalService({
    tmux: (args) => {
      calls.push(args);
      if (args.includes("has-session")) return fail();
      return ok();
    },
    langFallback: null,
  });
  term.ensure("t-lang-none");
  term.dispose();

  const created = calls.find((a) => a.includes("new-session"))!;
  expect(created.some((a) => a.startsWith("LANG="))).toBe(false);
});

// --- WP-3a: async list() / scan() behaviour --------------------------------

test("list() runs per-session capture probes concurrently (not serially)", async () => {
  const started: string[] = [];
  const resolvers: (() => void)[] = [];
  const tmuxAsync = async (args: string[]): Promise<TmuxResult> => {
    if (args.includes("list-sessions")) {
      return ok("a\t1700000000\t80\t24\nb\t1700000001\t80\t24\nc\t1700000002\t80\t24\n");
    }
    if (args.includes("capture-pane")) {
      started.push(args[args.indexOf("-t") + 1]);
      return new Promise<TmuxResult>((res) => {
        resolvers.push(() => res(ok("line")));
        // Safety net: even a regressed (serial) implementation completes, so
        // the test fails on the assertion below instead of hanging forever.
        setTimeout(() => res(ok("line")), 50);
      });
    }
    return ok();
  };
  const term = new TerminalService({ tmuxAsync });
  const p = term.list();
  // Let the roster resolve and the capture probes kick off. A serial
  // implementation would have started only "a" before anything resolves.
  const deadline = Date.now();
  while (started.length < 3 && Date.now() - deadline < 2000) await Bun.sleep(5);
  expect(started.sort()).toEqual(["a", "b", "c"]); // all started before ANY resolved
  for (const r of resolvers) r();
  const sessions = await p;
  expect(sessions.map((s) => s.name).sort()).toEqual(["a", "b", "c"]);
  term.dispose();
});

test("scan() never stacks: a tick during an in-flight probe round is skipped", async () => {
  let probes = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const tmuxAsync = async (args: string[]): Promise<TmuxResult> => {
    if (args.includes("has-session")) {
      probes++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Bun.sleep(30);
      inFlight--;
    }
    return ok();
  };
  const term = new TerminalService({ tmuxAsync });
  // Plant an owned session directly (ensure() would spawn a real attach PTY).
  (term as any).sessions.set("s", {
    pty: { write() {}, resize() {}, kill() {} },
    meta: { name: "s", state: "run", cols: 80, rows: 24, lastLine: "", createdAt: 0, attached: true },
    lastOutputAt: Date.now(),
  });
  (term as any).scan();
  (term as any).scan(); // in flight -> must be skipped
  await Bun.sleep(60);  // first round finishes (30ms probe)
  (term as any).scan(); // guard released -> runs
  await Bun.sleep(60);
  expect(maxInFlight).toBe(1); // probes never overlapped
  expect(probes).toBe(2);      // first + third tick only; the middle one was dropped
  term.dispose();
});

test("list() reports the scanner-debounced state, not a fresh raw inference", async () => {
  const term = new TerminalService({ tmux: fakeTmux({ list: "" }) });
  (term as any).sessions.set("s", {
    pty: { write() {}, resize() {}, kill() {} },
    meta: { name: "s", state: "run", cols: 80, rows: 24, lastLine: "", createdAt: 0, attached: true },
    lastOutputAt: Date.now(), // fresh output: a raw inferState would say "run"
  });
  // The scanner's debounced view has already settled on "wait" — list() must
  // surface exactly that, or pushed frames would flap run/wait again.
  (term as any).states.set("s", new StateHysteresis("wait"));
  const sessions = await term.list();
  expect(sessions.find((s) => s.name === "s")?.state).toBe("wait");
  term.dispose();
});
