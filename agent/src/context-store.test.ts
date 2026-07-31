import { expect, test } from "bun:test";
import { ContextStore } from "./context-store";
import type { SessionMeta } from "./protocol";

const meta = (name: string): SessionMeta => ({
  name, kind: "tmux", state: "run", cols: 80, rows: 24,
  lastLine: "", createdAt: 0, attached: true,
});

test("set 后 get 拿到数据", () => {
  const s = new ContextStore();
  s.set("work", "kimi", { used: 63476, total: 262144 }, 1000);
  expect(s.get("work")).toEqual({ tool: "kimi", used: 63476, total: 262144 });
});

test("同会话再 set 覆盖旧值", () => {
  const s = new ContextStore();
  s.set("work", "kimi", { used: 100, total: 262144 }, 1000);
  s.set("work", "kimi", { used: 200, total: 262144 }, 2000);
  expect(s.get("work")?.used).toBe(200);
});

test("total 可缺省（claude 的分母由 statusLine 单独给）", () => {
  const s = new ContextStore();
  s.set("work", "claude", { used: 142000 }, 1000);
  expect(s.get("work")).toEqual({ tool: "claude", used: 142000, total: undefined });
});

test("delete 后 get 返回 undefined", () => {
  const s = new ContextStore();
  s.set("work", "kimi", { used: 1, total: 2 }, 0);
  s.delete("work");
  expect(s.get("work")).toBeUndefined();
});

test("未知会话 get 返回 undefined", () => {
  expect(new ContextStore().get("nope")).toBeUndefined();
});

test("decorate 把 token 字段贴到对应会话上", () => {
  const s = new ContextStore();
  s.set("work", "kimi", { used: 63476, total: 262144 }, 0);
  const out = s.decorate([meta("work"), meta("other")]);
  expect(out[0].ctxTool).toBe("kimi");
  expect(out[0].ctxUsed).toBe(63476);
  expect(out[0].ctxTotal).toBe(262144);
  expect(out[1].ctxTool).toBeUndefined();
  expect(out[1].ctxUsed).toBeUndefined();
});

test("decorate 不修改入参数组与其元素", () => {
  const s = new ContextStore();
  s.set("work", "kimi", { used: 1, total: 2 }, 0);
  const input = [meta("work")];
  const out = s.decorate(input);
  expect(input[0].ctxUsed).toBeUndefined(); // 原对象没被污染
  expect(out).not.toBe(input);
});

test("decorate 对空 store 原样返回等价列表", () => {
  const s = new ContextStore();
  const out = s.decorate([meta("a"), meta("b")]);
  expect(out.map((m) => m.name)).toEqual(["a", "b"]);
  expect(out.every((m) => m.ctxUsed === undefined)).toBe(true);
});
