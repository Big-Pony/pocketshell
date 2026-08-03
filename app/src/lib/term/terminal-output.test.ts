import { test, expect } from "vitest";
import { lastOutput, type BufferLike } from "./terminal-output";

// Build a BufferLike from an array of physical lines. cursor sits on the last line.
function buf(lines: string[], viewportY = 0): BufferLike {
  return {
    length: lines.length,
    baseY: 0,
    cursorY: lines.length - 1,
    viewportY,
    getLine: (i) => (lines[i] === undefined ? undefined : { translateToString: () => lines[i] }),
  };
}

test("returns output of the last command (cursor on fresh empty prompt)", () => {
  const b = buf(["❯ echo hi", "hi", "❯ ls", "a.txt", "b.txt", "❯ "]);
  expect(lastOutput(b, 6)).toBe("a.txt\nb.txt");
});

test("returns output when command just ran (no trailing prompt yet)", () => {
  const b = buf(["❯ ls", "a.txt", "b.txt"]);
  expect(lastOutput(b, 3)).toBe("a.txt\nb.txt");
});

test("falls back to the visible viewport when no prompt exists (TUI)", () => {
  const b = buf(["│ Claude", "│ thinking", "│ done"], 0);
  expect(lastOutput(b, 3)).toBe("│ Claude\n│ thinking\n│ done");
});

test("collapses trailing blank lines to a single newline-free string", () => {
  const b = buf(["❯ echo hi", "hi", "", "", "❯ "]);
  expect(lastOutput(b, 5)).toBe("hi");
});

test("ignores mid-line prompt-like chars (PROMPT_RE anchored to line start)", () => {
  // "building 50% done" contains "% " but is output, not a prompt line. Without
  // the ^ anchor it would be mis-detected as the command boundary and truncate.
  const b = buf(["❯ make", "building 50% done", "linking", "❯ "]);
  expect(lastOutput(b, 4)).toBe("building 50% done\nlinking");
});
