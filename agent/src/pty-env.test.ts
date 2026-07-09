import { test, expect } from "bun:test";
import { ptyEnv, cjkFallbackLang } from "./pty-env";

test("ptyEnv always sets TERM to xterm-256color", () => {
  expect(ptyEnv({}).TERM).toBe("xterm-256color");
});

test("ptyEnv fills LANG when no locale present at all", () => {
  const e = ptyEnv({ PATH: "/usr/bin" });
  expect(e.LANG).toBe("en_US.UTF-8");
  expect(e.PATH).toBe("/usr/bin"); // passthrough
});

test("ptyEnv does not override an explicit LANG", () => {
  expect(ptyEnv({ LANG: "zh_CN.UTF-8" }).LANG).toBe("zh_CN.UTF-8");
});

test("ptyEnv respects an explicit LC_ALL and does not add LANG", () => {
  const e = ptyEnv({ LC_ALL: "C" });
  expect(e.LC_ALL).toBe("C");
  expect(e.LANG).toBeUndefined();
});

test("cjkFallbackLang returns en_US.UTF-8 when no locale var is present", () => {
  expect(cjkFallbackLang({})).toBe("en_US.UTF-8");
});

test("cjkFallbackLang returns null when LANG is already set", () => {
  expect(cjkFallbackLang({ LANG: "zh_CN.UTF-8" })).toBeNull();
});

test("cjkFallbackLang returns null when LC_ALL is already set", () => {
  expect(cjkFallbackLang({ LC_ALL: "C" })).toBeNull();
});
