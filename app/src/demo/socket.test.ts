// app/src/demo/socket.test.ts
import { test, expect, vi } from "vitest";
import { identityChannel, HELLO, HELLO_ACK } from "./identity-channel";
import { DemoSocket } from "./socket";

test("恒等通道：start 回 HELLO，收到 HELLO_ACK 即 established", () => {
  const ch = identityChannel();
  expect(ch.state).toBe("handshaking");
  expect(ch.start()).toEqual(HELLO);
  expect(ch.receive(HELLO_ACK)).toEqual({ status: "handshake", established: true });
  expect(ch.state).toBe("transport");
});

test("恒等通道：transport 态原样透出明文，send 原样返回", () => {
  const ch = identityChannel();
  ch.start();
  ch.receive(HELLO_ACK);
  const payload = new TextEncoder().encode('{"type":"ping"}');
  expect(ch.receive(payload)).toEqual({ status: "message", plaintext: payload });
  expect(ch.send(payload)).toEqual(payload);
});

test("恒等通道：握手态收到非 HELLO_ACK 判 fail（不静默吞）", () => {
  const ch = identityChannel();
  ch.start();
  expect(ch.receive(new Uint8Array([0xff])).status).toBe("fail");
  expect(ch.state).toBe("failed");
});

function makeSched() {
  const timers: Array<{ fn: () => void; ms: number }> = [];
  return {
    sched: { setTimeout: (fn: () => void, ms: number) => (timers.push({ fn, ms }), timers.length) },
    runAll: () => { const t = [...timers]; timers.length = 0; t.forEach((x) => x.fn()); },
    pending: () => timers.map((t) => t.ms),
  };
}

test("DemoSocket：首次连接立即 open，不延迟", () => {
  const { sched, pending } = makeSched();
  const s = new DemoSocket({ onFrame: () => {}, isReconnect: false, scheduler: sched });
  const opened = vi.fn();
  s.onopen = opened;
  s.start();
  expect(opened).toHaveBeenCalledTimes(1);
  expect(pending()).toEqual([]);
});

test("DemoSocket：重连延迟 2500ms 才 open —— 让「重连中」看得见", () => {
  const { sched, runAll, pending } = makeSched();
  const s = new DemoSocket({ onFrame: () => {}, isReconnect: true, scheduler: sched });
  const opened = vi.fn();
  s.onopen = opened;
  s.start();
  expect(opened).not.toHaveBeenCalled();
  expect(pending()).toEqual([2500]);
  runAll();
  expect(opened).toHaveBeenCalledTimes(1);
});

test("DemoSocket：收到 HELLO 回 HELLO_ACK（演完握手）", async () => {
  const { sched } = makeSched();
  const s = new DemoSocket({ onFrame: () => {}, isReconnect: false, scheduler: sched });
  const got: ArrayBuffer[] = [];
  s.onmessage = (ev) => got.push(ev.data);
  s.start();
  s.send(HELLO);
  await Promise.resolve();
  expect(got.length).toBe(1);
  expect(new Uint8Array(got[0])).toEqual(HELLO_ACK);
});

test("DemoSocket：回帧不在 send() 的调用栈里交付（真 WebSocket 也做不到）", async () => {
  // 同步交付会让 Connection 的握手超时定时器变成孤儿：established 的
  // clearHsTimer() 跑在 hsTimer 装上之前，那个 5 秒 kill 定时器就没人清了。
  // 线上表现是演示站每 ~8 秒自己断一次。
  const { sched } = makeSched();
  const s = new DemoSocket({ onFrame: () => {}, isReconnect: false, scheduler: sched });
  const got: ArrayBuffer[] = [];
  s.onmessage = (ev) => got.push(ev.data);
  s.start();
  s.send(HELLO);
  expect(got, "HELLO_ACK 同步就交付了").toEqual([]);
  await Promise.resolve();
  expect(got.length).toBe(1);
});

test("DemoSocket：握手后 send 的字节被解析成 JSON 交给 onFrame", () => {
  // onFrame 是上行（Connection → agent），仍是同步的，不受回帧异步化影响。
  const { sched } = makeSched();
  const frames: unknown[] = [];
  const s = new DemoSocket({ onFrame: (m) => frames.push(m), isReconnect: false, scheduler: sched });
  s.onmessage = () => {};
  s.start();
  s.send(HELLO);
  s.send(new TextEncoder().encode('{"type":"listSessions"}'));
  expect(frames).toEqual([{ type: "listSessions" }]);
});

test("DemoSocket：push 把对象编码成 UTF-8 JSON 经 onmessage 送出", async () => {
  const { sched } = makeSched();
  const s = new DemoSocket({ onFrame: () => {}, isReconnect: false, scheduler: sched });
  const got: ArrayBuffer[] = [];
  s.onmessage = (ev) => got.push(ev.data);
  s.start();
  s.send(HELLO);
  await Promise.resolve();
  got.length = 0;
  s.push({ type: "pong" });
  await Promise.resolve();
  expect(new TextDecoder().decode(new Uint8Array(got[0]))).toBe('{"type":"pong"}');
});

test("DemoSocket：close 后 push 不再送出（防止已关闭的 socket 继续喂数据）", async () => {
  const { sched } = makeSched();
  const s = new DemoSocket({ onFrame: () => {}, isReconnect: false, scheduler: sched });
  const got: ArrayBuffer[] = [];
  const closed = vi.fn();
  s.onmessage = (ev) => got.push(ev.data);
  s.onclose = closed;
  s.start();
  s.send(HELLO);
  await Promise.resolve();
  got.length = 0;
  s.close();
  expect(closed).toHaveBeenCalledTimes(1);
  s.push({ type: "pong" });
  await Promise.resolve();
  expect(got).toEqual([]);
});

test("DemoSocket：已入队的帧在 close 之后不再交付", async () => {
  // 回帧异步化之后多了个窗口：帧已排队、还没交付时 socket 被关掉。
  const { sched } = makeSched();
  const s = new DemoSocket({ onFrame: () => {}, isReconnect: false, scheduler: sched });
  const got: ArrayBuffer[] = [];
  s.onmessage = (ev) => got.push(ev.data);
  s.start();
  s.send(HELLO);
  await Promise.resolve();
  got.length = 0;
  s.push({ type: "pong" }); // 入队
  s.close();                // 同一个同步段里关掉
  await Promise.resolve();
  expect(got).toEqual([]);
});

test("DemoSocket：close 幂等，onclose 只触发一次", () => {
  const { sched } = makeSched();
  const s = new DemoSocket({ onFrame: () => {}, isReconnect: false, scheduler: sched });
  const closed = vi.fn();
  s.onclose = closed;
  s.start();
  s.close();
  s.close();
  expect(closed).toHaveBeenCalledTimes(1);
});

test("DemoSocket：close 之后即使定时器到点也不 open（重连中途被关掉）", () => {
  const { sched, runAll } = makeSched();
  const s = new DemoSocket({ onFrame: () => {}, isReconnect: true, scheduler: sched });
  const opened = vi.fn();
  s.onopen = opened;
  s.start();
  s.close();
  runAll();
  expect(opened).not.toHaveBeenCalled();
});
