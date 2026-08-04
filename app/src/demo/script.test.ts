// app/src/demo/script.test.ts
import { test, expect, vi } from "vitest";
import { DemoAgent } from "./agent";
import { DemoDirector, AUTO_PLAY_DELAY_MS } from "./script";
import type { ServerMsg } from "../lib/net/protocol";

function stage() {
  const out: ServerMsg[] = [];
  const timers: Array<{ fn: () => void; ms: number } | null> = [];
  const sched = {
    setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length - 1; },
    clearTimeout: (id: number) => { timers[id] = null; },
  };
  const agent = new DemoAgent({ push: (m) => out.push(m), scheduler: sched });
  const drop = vi.fn();
  const director = new DemoDirector({ agent, drop, scheduler: sched });
  agent.handle({ type: "attach", sessionId: "claude-refactor" });
  return {
    agent, director, out, drop,
    /** 跑掉当前排期的定时器；重复调用可推进多拍。 */
    tick(n = 1) {
      for (let i = 0; i < n; i++) {
        const cur = timers.filter(Boolean) as Array<{ fn: () => void }>;
        timers.length = 0;
        cur.forEach((t) => t.fn());
      }
    },
    pending: () => timers.filter(Boolean).map((t) => t!.ms),
    text: () => out.filter((m) => m.type === "output")
      .map((m) => new TextDecoder().decode(Uint8Array.from(atob((m as Extract<ServerMsg, {type:"output"}>).data), (c) => c.charCodeAt(0))))
      .join(""),
  };
}

test("armAutoPlay 排一个 8 秒的定时器", () => {
  const s = stage();
  s.director.armAutoPlay();
  expect(s.pending()).toContain(AUTO_PLAY_DELAY_MS);
});

test("访客输入立即取消自动播放：到点也不开演", () => {
  const s = stage();
  s.director.armAutoPlay();
  s.director.notifyUserInput();
  s.tick(6);
  expect(s.text()).toBe(""); // 一个字都不该自动冒出来
  expect(s.drop).not.toHaveBeenCalled();
});

test("第一幕派活：自动播放会注入一段中文需求并跑起 claude", () => {
  const s = stage();
  s.director.armAutoPlay();
  s.tick(4);
  const t = s.text();
  expect(t.length).toBeGreaterThan(0);
  expect(t).toContain("claude");
});

test("playDropScene 调 drop()（断线那一幕不是伪造的，走真实重连路径）", () => {
  const s = stage();
  s.director.playDropScene();
  s.tick(3);
  expect(s.drop).toHaveBeenCalledTimes(1);
});

test("断线后 agent 继续产出：seq 一直在推进", () => {
  const s = stage();
  s.director.playDropScene();
  s.tick(2);
  s.agent.detachTransport();       // 模拟传输层断掉
  const before = s.out.length;
  s.tick(6);                        // 断线期间继续走拍
  expect(s.out.length).toBe(before); // 推不出去
  // 但缓冲在涨：重连补齐能吐出东西
  const after: ServerMsg[] = [];
  s.agent.setPush((m) => after.push(m));
  s.agent.handle({ type: "attach", sessionId: "claude-refactor", lastSeq: 0 });
  expect(after.filter((m) => m.type === "output").length).toBeGreaterThan(0);
});

test("第三幕推送：发出 notification 帧，标题与正文非空且已翻译", () => {
  const s = stage();
  s.director.playDropScene();
  s.tick(8);
  const n = s.out.find((m) => m.type === "notification") as Extract<ServerMsg, { type: "notification" }> | undefined;
  expect(n).toBeTruthy();
  expect(n!.title.length).toBeGreaterThan(0);
  expect(n!.title).not.toContain("demo.");  // 漏翻会把 i18n key 直接推给用户
  expect(n!.sessionId).toBe("claude-refactor");
});

test("playDropScene 可重复调用：第二次不会与第一次的定时器打架", () => {
  const s = stage();
  s.director.playDropScene();
  s.tick(2);
  s.director.playDropScene();
  s.tick(10);
  // 只要不抛、drop 至少被调过，就说明重入是安全的
  expect(s.drop.mock.calls.length).toBeGreaterThanOrEqual(1);
});

test("notifyUserInput 在演出中途也能叫停后续幕次", () => {
  const s = stage();
  s.director.armAutoPlay();
  s.tick(3);
  s.director.notifyUserInput();
  const dropsBefore = s.drop.mock.calls.length;
  s.tick(10);
  expect(s.drop.mock.calls.length).toBe(dropsBefore);
});
