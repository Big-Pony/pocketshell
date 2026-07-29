import { describe, it, expect } from "vitest";
import { containsSubmit, anchorRow, rowsBack, trimTrailingPrompt, OutputAnchors } from "./output-anchor";
import { PROMPT_RE } from "./terminal-output";

const enc = (s: string) => new TextEncoder().encode(s);

describe("containsSubmit", () => {
  it("detects the Return the custom keyboard sends (\\r)", () => {
    expect(containsSubmit(enc("ls -la\r"))).toBe(true);
  });
  it("detects a newline from a pasted block", () => {
    expect(containsSubmit(enc("line1\nline2\n"))).toBe(true);
  });
  it("ignores plain typing — the anchor must not move mid-command", () => {
    expect(containsSubmit(enc("ls -la"))).toBe(false);
  });
  it("ignores control keys that are not submits (Ctrl-C, Tab, arrows)", () => {
    expect(containsSubmit(enc("\x03"))).toBe(false);
    expect(containsSubmit(enc("\t"))).toBe(false);
    expect(containsSubmit(enc("\x1b[A"))).toBe(false);
  });
  it("ignores empty input", () => {
    expect(containsSubmit(new Uint8Array())).toBe(false);
  });
});

describe("anchorRow", () => {
  it("is the absolute buffer row the cursor sits on", () => {
    expect(anchorRow({ baseY: 1000, cursorY: 12 })).toBe(1012);
  });
  it("works with no scrollback yet", () => {
    expect(anchorRow({ baseY: 0, cursorY: 3 })).toBe(3);
  });
});

describe("rowsBack", () => {
  // A distance above the cursor, NOT an absolute row: xterm and tmux disagree on
  // row origin (measured: xterm cursorY=23 vs tmux cursor_y=3 on one pane), and
  // both ends can agree on "how far above the cursor".
  it("is the gap between the anchor and the current cursor", () => {
    expect(rowsBack(480, 520)).toBe(40);
  });
  it("is 0 when the cursor has not moved since the anchor", () => {
    expect(rowsBack(500, 500)).toBe(0);
  });
  it("clamps to 0 if the anchor somehow ends up below the cursor (buffer reset)", () => {
    expect(rowsBack(520, 500)).toBe(0);
  });
});

describe("trimTrailingPrompt", () => {
  it("drops the bare prompt tmux leaves at the bottom of the capture", () => {
    expect(trimTrailingPrompt("$ ls\na.txt\nb.txt\n$ ", PROMPT_RE)).toBe("$ ls\na.txt\nb.txt");
  });
  it("keeps a prompt line that has a real command on it", () => {
    expect(trimTrailingPrompt("$ ls\na.txt\n$ pwd", PROMPT_RE)).toBe("$ ls\na.txt\n$ pwd");
  });
  it("keeps output that merely ends in text", () => {
    expect(trimTrailingPrompt("building\ndone", PROMPT_RE)).toBe("building\ndone");
  });
  it("never empties a single-line capture", () => {
    expect(trimTrailingPrompt("$ ", PROMPT_RE)).toBe("$");
  });
  it("strips trailing blank padding", () => {
    expect(trimTrailingPrompt("out\n\n\n  \n", PROMPT_RE)).toBe("out");
  });
});

describe("OutputAnchors", () => {
  it("records the row when a submit goes out", () => {
    const a = new OutputAnchors();
    expect(a.record("s1", enc("ls\r"), { baseY: 100, cursorY: 5 })).toBe(true);
    expect(a.get("s1")).toBe(105);
  });

  it("does NOT record for input without a submit — mid-typing must not move it", () => {
    const a = new OutputAnchors();
    a.record("s1", enc("ls\r"), { baseY: 100, cursorY: 5 });
    a.record("s1", enc("more typing"), { baseY: 100, cursorY: 9 });
    expect(a.get("s1")).toBe(105);
  });

  it("moves the anchor to the newest command", () => {
    const a = new OutputAnchors();
    a.record("s1", enc("ls\r"), { baseY: 100, cursorY: 5 });
    a.record("s1", enc("pwd\r"), { baseY: 140, cursorY: 2 });
    expect(a.get("s1")).toBe(142);
  });

  it("keeps anchors per session — switching tabs must not cross the wires", () => {
    const a = new OutputAnchors();
    a.record("s1", enc("ls\r"), { baseY: 10, cursorY: 1 });
    a.record("s2", enc("pwd\r"), { baseY: 900, cursorY: 4 });
    expect(a.get("s1")).toBe(11);
    expect(a.get("s2")).toBe(904);
  });

  it("has no anchor for a session where the user never typed (typed on the desktop)", () => {
    // This is the documented fallback trigger: the App only sees what IT sent,
    // so a command typed directly on the computer leaves no anchor and the
    // caller must fall back to the prompt-regex heuristic.
    expect(new OutputAnchors().get("never")).toBeUndefined();
  });

  it("records nothing when the terminal buffer is unavailable", () => {
    const a = new OutputAnchors();
    expect(a.record("s1", enc("ls\r"), undefined)).toBe(false);
    expect(a.get("s1")).toBeUndefined();
  });

  it("clear() drops a session's anchor (session killed / tab closed)", () => {
    const a = new OutputAnchors();
    a.record("s1", enc("ls\r"), { baseY: 1, cursorY: 1 });
    a.clear("s1");
    expect(a.get("s1")).toBeUndefined();
  });
});
