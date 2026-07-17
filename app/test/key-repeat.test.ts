import { test, expect } from "vitest";
import { createKeyRepeater, type RepeatScheduler } from "../src/lib/key-repeat";

// Manual clock: 1ms-step advance; fires due timeouts and interval ticks.
// Timer handles are plain increasing ids like the Connection test scheduler.
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timeouts = new Map<number, { fn: () => void; at: number }>();
  const intervals = new Map<number, { fn: () => void; every: number; next: number }>();
  const sched: RepeatScheduler = {
    setTimeout: (fn, ms) => { const id = nextId++; timeouts.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: (id) => { timeouts.delete(id); },
    setInterval: (fn, ms) => { const id = nextId++; intervals.set(id, { fn, every: ms, next: now + ms }); return id; },
    clearInterval: (id) => { intervals.delete(id); },
  };
  const advance = (ms: number) => {
    for (let t = 0; t < ms; t++) {
      now++;
      for (const [id, tt] of [...timeouts]) if (tt.at <= now) { timeouts.delete(id); tt.fn(); }
      for (const [id, iv] of [...intervals]) if (iv.next <= now) { iv.next += iv.every; iv.fn(); }
    }
  };
  return { sched, advance };
}

test("first shot fires immediately on start, nothing more before the delay", () => {
  const { sched, advance } = fakeClock();
  let n = 0;
  const rep = createKeyRepeater(() => n++, { sched });
  rep.start();
  expect(n).toBe(1);
  advance(399);
  expect(n).toBe(1);
});

test("after the 400ms delay it repeats every 60ms", () => {
  const { sched, advance } = fakeClock();
  let n = 0;
  const rep = createKeyRepeater(() => n++, { sched });
  rep.start();
  advance(400); // delay elapses -> interval armed, no tick yet
  expect(n).toBe(1);
  advance(60);
  expect(n).toBe(2);
  advance(60 * 5);
  expect(n).toBe(7); // 1 first + 6 ticks
});

test("stop during the initial delay prevents any repeat", () => {
  const { sched, advance } = fakeClock();
  let n = 0;
  const rep = createKeyRepeater(() => n++, { sched });
  rep.start();
  advance(200);
  rep.stop();
  advance(2000);
  expect(n).toBe(1); // only the first shot
});

test("stop during the repeat phase halts immediately", () => {
  const { sched, advance } = fakeClock();
  let n = 0;
  const rep = createKeyRepeater(() => n++, { sched });
  rep.start();
  advance(400 + 120); // first + 2 ticks
  expect(n).toBe(3);
  rep.stop();
  advance(1000);
  expect(n).toBe(3);
});

test("start while running is idempotent (no double timers)", () => {
  const { sched, advance } = fakeClock();
  let n = 0;
  const rep = createKeyRepeater(() => n++, { sched });
  rep.start();
  rep.start(); // must not fire again nor arm a second chain
  expect(n).toBe(1);
  advance(400 + 60);
  expect(n).toBe(2);
});

test("stop is safe anytime; active() reflects the running state", () => {
  const { sched, advance } = fakeClock();
  let n = 0;
  const rep = createKeyRepeater(() => n++, { sched });
  expect(rep.active()).toBe(false);
  rep.stop(); // before start: no-op, no throw
  rep.start();
  expect(rep.active()).toBe(true);
  advance(400 + 60);
  rep.stop();
  expect(rep.active()).toBe(false);
  rep.stop(); // twice: still fine
  advance(500);
  expect(n).toBe(2);
});

test("custom delay/interval are honored", () => {
  const { sched, advance } = fakeClock();
  let n = 0;
  const rep = createKeyRepeater(() => n++, { delayMs: 100, intervalMs: 25, sched });
  rep.start();
  advance(99);
  expect(n).toBe(1);
  advance(1 + 25 * 4);
  expect(n).toBe(5);
});
