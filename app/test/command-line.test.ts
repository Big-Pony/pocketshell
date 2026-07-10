import { test, expect } from "vitest";
import { emptyCmdLine, feed } from "../src/lib/command-line";

test("append visible characters", () => {
  let s = emptyCmdLine();
  s = feed(s, "l");
  s = feed(s, "s");
  expect(s.line).toBe("ls");
  expect(s.trusted).toBe(true);
});

test("backspace removes the last character", () => {
  let s = feed(emptyCmdLine(), "lss");
  s = feed(s, "\x7f");
  expect(s.line).toBe("ls");
});

test("enter commits to history and clears the line", () => {
  let s = feed(emptyCmdLine(), "git status");
  s = feed(s, "\r");
  expect(s.line).toBe("");
  expect(s.history[0]).toBe("git status");
});

test("enter ignores whitespace-only lines", () => {
  let s = feed(emptyCmdLine(), "   ");
  s = feed(s, "\r");
  expect(s.history).toEqual([]);
});

test("Ctrl-C and Ctrl-U clear the line and reset trusted", () => {
  let s = feed(emptyCmdLine(), "half");
  s = feed(s, "\x1b[A"); // make it untrusted first
  expect(s.trusted).toBe(false);
  s = feed(s, "\x03"); // Ctrl-C
  expect(s.line).toBe("");
  expect(s.trusted).toBe(true);
});

test("arrow key sequence marks the line untrusted", () => {
  let s = feed(emptyCmdLine(), "ls");
  s = feed(s, "\x1b[A");
  expect(s.trusted).toBe(false);
});

test("lone Esc clears the line", () => {
  let s = feed(emptyCmdLine(), "ls");
  s = feed(s, "\x1b");
  expect(s.line).toBe("");
  expect(s.trusted).toBe(true);
});

test("Tab marks the line untrusted", () => {
  let s = feed(emptyCmdLine(), "gi");
  s = feed(s, "\t");
  expect(s.trusted).toBe(false);
});

test("supports CJK characters", () => {
  let s = feed(emptyCmdLine(), "echo 你好");
  expect(s.line).toBe("echo 你好");
});

test("history deduplication: repeated command moves to front", () => {
  let s = emptyCmdLine();
  s = feed(s, "ls\r");
  s = feed(s, "pwd\r");
  s = feed(s, "ls\r");
  expect(s.history).toEqual(["ls", "pwd"]);
});

test("untrusted line is not committed to history on Enter", () => {
  let s = feed(emptyCmdLine(), "ls -la");
  s = feed(s, "\x1b[D"); // cursor-left -> untrusted (reconstruction unreliable)
  expect(s.trusted).toBe(false);
  s = feed(s, "x");
  s = feed(s, "\r"); // Enter: drop the guessed line instead of polluting history
  expect(s.history).toEqual([]);
  expect(s.line).toBe("");
  expect(s.trusted).toBe(true); // recovers for the next line
});
