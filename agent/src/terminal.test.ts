import { test, expect } from "bun:test";
import { TerminalService, type TmuxRunner } from "./terminal";

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

test("list() surfaces foreign tmux sessions as idle + attached:false", () => {
  const term = new TerminalService({
    tmux: fakeTmux({
      list: "work\t1700000000\t120\t40\nbuild\t1700000100\t80\t24\n",
      capture: { work: "$ vim main.ts", build: "npm run build" },
    }),
  });
  const sessions = term.list();
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

test("list() tolerates a missing/failing tmux (roster query) -> empty", () => {
  const term = new TerminalService({ tmux: () => fail() });
  expect(term.list()).toEqual([]);
  term.dispose();
});

test("roster + previews force tmux UTF-8 (-u) so launchd's C locale can't sanitize tab delimiters to _", () => {
  const calls: string[][] = [];
  const term = new TerminalService({
    tmux: fakeTmux({ list: "work\t1700000000\t80\t24\n", capture: { work: "hi" } }, calls),
  });
  term.list();
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
