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

test("history() exports full pane scrollback + visible area with colours (base64)", () => {
  const calls: string[][] = [];
  const term = new TerminalService({
    tmux: (args) => {
      calls.push(args);
      if (args[0] === "display-message") return ok("0\n"); // alternate_on = 0
      if (args.includes("capture-pane")) return ok("\x1b[36mLINE_1\x1b[39m\nLINE_2");
      return ok();
    },
  });
  const r = term.history("work");
  expect(Buffer.from(r.data, "base64").toString("utf8")).toBe("\x1b[36mLINE_1\x1b[39m\nLINE_2");
  const cap = calls.find((a) => a.includes("capture-pane"))!;
  expect(cap).toEqual(["-u", "capture-pane", "-e", "-p", "-J", "-S", "-", "-E", "-", "-t", "work"]);
  term.dispose();
});

test("history() captures the pane even when alternate_on is set", () => {
  const term = new TerminalService({
    tmux: (args) => (args.includes("capture-pane") ? ok("ALT_LINE") : ok("1")),
  });
  expect(term.history("vim").data).toBe(Buffer.from("ALT_LINE").toString("base64"));
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
