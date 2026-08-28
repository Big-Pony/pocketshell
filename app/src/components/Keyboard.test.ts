import { test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Keyboard from "./Keyboard.svelte";

function openOps(onText = vi.fn(), onCommand = vi.fn(), extra = {}) {
  const r = render(Keyboard, { props: { onText, onCommand, ...extra } });
  return { onText, onCommand, r };
}

// This jsdom version has no native PointerEvent constructor, so
// fireEvent.pointerDown/Move(el, { clientX }) silently drops clientX (it falls
// back to a plain Event, whose constructor ignores unknown init keys). Build
// the event by hand and force clientX on so the swipe-cancel test below can
// actually exercise Keyboard.svelte's clientX-based threshold check.
function pointerEventAt(type: string, clientX: number): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "clientX", { value: clientX });
  return ev;
}

// Phase 3 (需求8): byte-producing keys now defer their first shot by one
// animation frame so a horizontal swipe starting on a key can cancel it
// before anything is sent — see keyDown/keyMove/keyUp in Keyboard.svelte. A
// real tap always generates a pointerup shortly after pointerdown, and that
// pointerup fires the deferred shot immediately (the "released before the
// frame" fast path in keyUp), so these tests now fire both events to model
// an actual tap rather than an indefinite hold.
// 需求 1（12 期）：这个键原本 id 是 "Del"、发 \x1b[3~（前向删除，删光标右边）。
// 行尾按下时光标右边没有字符，于是「按了没反应」——这就是「删除按钮失效」的真相，
// 按钮本身从未坏过。改为退格：删光标左边，与笔记本 ⌫ 一致。
test("ops sub-tab: the delete key sends backspace (deletes to the LEFT of the cursor)", async () => {
  const { onText, r } = openOps();
  await fireEvent.click(screen.getByText("✂ 快捷操作"));
  const key = r.container.querySelector('.ops-nav2 [data-key-id="Backspace"]')!;
  await fireEvent.pointerDown(key);
  await fireEvent.pointerUp(key);
  expect(onText).toHaveBeenCalledWith("\x7f");
});

test("ops sub-tab: Tab key sends the tab byte via onText", async () => {
  const { onText } = openOps();
  await fireEvent.click(screen.getByText("✂ 快捷操作"));
  const key = screen.getByText("Tab");
  await fireEvent.pointerDown(key);
  await fireEvent.pointerUp(key);
  expect(onText).toHaveBeenCalledWith("\x09");
});

test("ops sub-tab: paste / selectText / selectAllCopy buttons dispatch commands", async () => {
  const { onCommand } = openOps();
  await fireEvent.click(screen.getByText("✂ 快捷操作"));
  await fireEvent.click(screen.getByText("粘贴"));
  await fireEvent.click(screen.getByText("选择文本"));
  await fireEvent.click(screen.getByText("全选复制"));
  expect(onCommand).toHaveBeenCalledWith({ type: "paste" });
  expect(onCommand).toHaveBeenCalledWith({ type: "copyMode" });
  expect(onCommand).toHaveBeenCalledWith({ type: "selectAllCopy" });
});

test("ops sub-tab: PgUp/PgDn buttons send page escape sequences via onText", async () => {
  const { onText } = openOps();
  await fireEvent.click(screen.getByText("✂ 快捷操作"));
  const pgUp = screen.getByText("PgUp");
  await fireEvent.pointerDown(pgUp);
  await fireEvent.pointerUp(pgUp);
  const pgDn = screen.getByText("PgDn");
  await fireEvent.pointerDown(pgDn);
  await fireEvent.pointerUp(pgDn);
  expect(onText).toHaveBeenCalledWith("\x1b[5~");
  expect(onText).toHaveBeenCalledWith("\x1b[6~");
});

test("ops sub-tab: D-pad up sends the arrow-up escape via onText", async () => {
  const { onText } = openOps();
  await fireEvent.click(screen.getByText("✂ 快捷操作"));
  const key = screen.getByText("↑");
  await fireEvent.pointerDown(key);
  await fireEvent.pointerUp(key);
  expect(onText).toHaveBeenCalledWith("\x1b[A");
});

test("ops sub-tab: Home button sends escape sequence via onText", async () => {
  const { onText } = openOps();
  await fireEvent.click(screen.getByText("✂ 快捷操作"));
  const key = screen.getByText("Home");
  await fireEvent.pointerDown(key);
  await fireEvent.pointerUp(key);
  expect(onText).toHaveBeenCalledWith("\x1b[H");
});

// 13 期需求 2：联想条改「抬手才结算」，且交还原生横向滚动。
// 按下即选中 + touch-action:none 两条叠加，导致这条提示区既滚不动
// 也躲不开——手指一碰就选中，根本不给滚动的机会。
test("normal state shows hint chips and tapping one calls onHint", async () => {
  const onHint = vi.fn();
  render(Keyboard, {
    props: { onText: () => {}, onCommand: () => {}, hints: ["git status", "ls -la"], onHint },
  });
  const chip = screen.getByText("git status");
  await fireEvent.pointerDown(chip);
  expect(onHint, "按下不应触发——要等抬手").not.toHaveBeenCalled();
  await fireEvent.pointerUp(chip);
  expect(onHint).toHaveBeenCalledWith("git status");
});

test("联想条：按下后横向拖过阈值再抬手，判为滚动、不补全", async () => {
  const onHint = vi.fn();
  render(Keyboard, {
    props: { onText: () => {}, onCommand: () => {}, hints: ["git status"], onHint },
  });
  const chip = screen.getByText("git status");
  await fireEvent(chip, pointerEventAt("pointerdown", 100));
  await fireEvent(chip, pointerEventAt("pointerup", 140));
  expect(onHint).not.toHaveBeenCalled();
});

test("联想条：手指滑出 chip 后抬手不补全（pointerleave 清状态）", async () => {
  const onHint = vi.fn();
  render(Keyboard, {
    props: { onText: () => {}, onCommand: () => {}, hints: ["git status"], onHint },
  });
  const chip = screen.getByText("git status");
  await fireEvent.pointerDown(chip);
  await fireEvent.pointerLeave(chip);
  await fireEvent.pointerUp(chip);
  expect(onHint).not.toHaveBeenCalled();
});

test("Fn state shows F1–F12 in the function row", async () => {
  render(Keyboard, {
    props: { onText: () => {}, onCommand: () => {}, hints: ["git status"] },
  });
  expect(screen.queryByText("F1")).toBeNull();
  await fireEvent.pointerDown(screen.getByText("Fn"));
  expect(screen.getByText("F1")).toBeInTheDocument();
});

test("Esc always sends the escape sequence", async () => {
  const onText = vi.fn();
  render(Keyboard, {
    props: { onText, onCommand: () => {}, hints: [] },
  });
  const key = screen.getByText("Esc");
  await fireEvent.pointerDown(key);
  await fireEvent.pointerUp(key);
  expect(onText).toHaveBeenCalledWith("\x1b");
});

test("ops sub-tab: center Enter button sends carriage return", async () => {
  const { onText } = openOps();
  await fireEvent.click(screen.getByText("✂ 快捷操作"));
  const key = screen.getByText("⏎");
  await fireEvent.pointerDown(key);
  await fireEvent.pointerUp(key);
  expect(onText).toHaveBeenCalledWith("\r");
});

// 需求8 Phase 3: a horizontal drag that starts on a byte key is a panel
// swipe, not a keypress — the deferred first shot must be cancelled so
// nothing is sent, even though the same key eventually gets a pointerup.
test("ops sub-tab: dragging off a key horizontally cancels the deferred send (swipe, not a tap)", async () => {
  const { onText } = openOps();
  await fireEvent.click(screen.getByText("✂ 快捷操作"));
  const key = screen.getByText("Home");
  await fireEvent(key, pointerEventAt("pointerdown", 100));
  // Travel well past KEY_SWIPE_CANCEL_PX (12px) before the deferred frame
  // fires — this is what a real swipe looks like, and must NOT emit a byte.
  await fireEvent(key, pointerEventAt("pointermove", 140));
  await fireEvent(key, pointerEventAt("pointerup", 140));
  expect(onText).not.toHaveBeenCalled();
});

// Rollover regression: a second byte key going down before the first key's
// deferred first-shot rAF has fired used to cancel — and never fire — the
// first key's pending shot when pendingKey/pendingRaf got reassigned to the
// second key. keyDown must now flush the still-pending key immediately so a
// fast two-finger rollover (real taps on both) doesn't drop the first byte.
test("keys tab: rollover — a second key going down before the first key's deferred shot fires must not drop the first key's byte", async () => {
  const { onText } = openOps();
  const keyQ = screen.getByText("Q");
  const keyW = screen.getByText("W");
  // Q down, then W down BEFORE Q's pointerup/deferred rAF — this is the
  // overlapping-key-press (rollover) scenario from the bug report.
  await fireEvent(keyQ, pointerEventAt("pointerdown", 10));
  await fireEvent(keyW, pointerEventAt("pointerdown", 50));
  await fireEvent(keyQ, pointerEventAt("pointerup", 10));
  await fireEvent(keyW, pointerEventAt("pointerup", 50));
  expect(onText).toHaveBeenCalledWith("q");
  expect(onText).toHaveBeenCalledWith("w");
});

// 需求 2（12 期）：方向盘右侧 2×2 从左上顺时针依次是 esc / tab / space / del。
// 网格按行填充，所以顺时针的视觉顺序 = DOM 顺序 Esc, Tab, Del, Space
//（左上 → 右上 → 左下 → 右下）。这条断言存在的意义是：把「顺时针」这个
// 只在视觉上成立的约定，翻译成一条机器能守住的 DOM 顺序。
test("ops sub-tab: the 2x2 pad next to the D-pad reads Esc/Tab/Del/Space clockwise", async () => {
  const { r } = openOps();
  await fireEvent.click(screen.getByText("✂ 快捷操作"));
  const pad = r.container.querySelector(".ops-nav2")!;
  const caps = Array.from(pad.querySelectorAll("button")).map((b) => b.textContent?.trim());
  expect(caps).toEqual(["Esc", "Tab", "⌫", "space"]);
});

// 四个动作按钮升到第一排后仍必须可点（位置变了，行为不变）。
test("ops sub-tab: the action buttons now sit in the first row", async () => {
  const { r } = openOps();
  await fireEvent.click(screen.getByText("✂ 快捷操作"));
  const row = r.container.querySelector(".ops-row")!;
  const labels = Array.from(row.querySelectorAll("button")).map((b) => b.textContent?.trim());
  expect(labels).toEqual(["选择文本", "全选复制", "复制输出", "粘贴"]);
});

// Home/End/PgUp/PgDn 保留（不是删除，是下移到最后一排）——TUI 翻页的唯一出口。
test("ops sub-tab: Home/End/PgUp/PgDn move to the last row and stay functional", async () => {
  const { r } = openOps();
  await fireEvent.click(screen.getByText("✂ 快捷操作"));
  const bottom = r.container.querySelector(".ops-bottom")!;
  const caps = Array.from(bottom.querySelectorAll("button")).map((b) => b.textContent?.trim());
  expect(caps).toEqual(["Home", "End", "PgUp", "PgDn"]);
});

// ---------------------------------------------------------------------------
// 12 期：键盘布局三选一（classic / layered / flick）。
// classic 是默认值且行为逐字不变 —— 上面所有既有断言都不带 kbLayout，
// 它们继续通过就是这条硬要求的守门人。
// ---------------------------------------------------------------------------

test("默认 classic：14 键的数字行还在（既有布局零改动）", () => {
  const { container } = render(Keyboard, { props: { onText: vi.fn(), onCommand: vi.fn() } });
  expect(container.querySelector('[data-key-id="`"]')).toBeTruthy();
  expect(container.querySelector('[data-key-id="Caps"]')).toBeTruthy();
});

test("layered：字母层没有数字键，底行有层切换键", () => {
  const { container } = render(Keyboard, {
    props: { onText: vi.fn(), onCommand: vi.fn(), kbLayout: "layered" },
  });
  expect(container.querySelector('[data-key-id="1"]')).toBeNull();
  expect(container.querySelector('[data-key-id="q"]')).toBeTruthy();
  expect(container.querySelector('[data-key-id="__layer"]')).toBeTruthy();
});

test("layered：点层切换键翻到符号层，再点翻回来", async () => {
  const { container } = render(Keyboard, {
    props: { onText: vi.fn(), onCommand: vi.fn(), kbLayout: "layered" },
  });
  const layer = container.querySelector('[data-key-id="__layer"]') as HTMLElement;
  await fireEvent.pointerDown(layer);
  await fireEvent.pointerUp(layer);
  expect(container.querySelector('[data-key-id="1"]'), "切层后应出现数字").toBeTruthy();
  expect(container.querySelector('[data-key-id="q"]'), "切层后字母应隐藏").toBeNull();
  await fireEvent.pointerDown(layer);
  await fireEvent.pointerUp(layer);
  expect(container.querySelector('[data-key-id="q"]'), "再切应回到字母").toBeTruthy();
});

test("层切换键自己不发任何字节", async () => {
  const onText = vi.fn();
  const { container } = render(Keyboard, {
    props: { onText, onCommand: vi.fn(), kbLayout: "layered" },
  });
  const layer = container.querySelector('[data-key-id="__layer"]') as HTMLElement;
  await fireEvent.pointerDown(layer);
  await fireEvent.pointerUp(layer);
  expect(onText).not.toHaveBeenCalled();
});

test("flick：字母键帽带角标（第二字符），q 的角标是 1", () => {
  const { container } = render(Keyboard, {
    props: { onText: vi.fn(), onCommand: vi.fn(), kbLayout: "flick" },
  });
  const q = container.querySelector('[data-key-id="q"]') as HTMLElement;
  expect(q.querySelector(".up")?.textContent).toBe("1");
});

test("layered / flick 都有独立方向键行", () => {
  for (const kbLayout of ["layered", "flick"] as const) {
    const { container } = render(Keyboard, {
      props: { onText: vi.fn(), onCommand: vi.fn(), kbLayout },
    });
    for (const id of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) {
      expect(container.querySelector(`[data-key-id="${id}"]`), `${kbLayout} 缺 ${id}`).toBeTruthy();
    }
  }
});

test("三套布局的 esc/tab/ctrl/alt 都在（终端高频键不进第二层）", () => {
  for (const kbLayout of ["classic", "layered", "flick"] as const) {
    const { container } = render(Keyboard, {
      props: { onText: vi.fn(), onCommand: vi.fn(), kbLayout },
    });
    for (const id of ["Esc", "Tab", "Ctrl", "Alt"]) {
      expect(container.querySelector(`[data-key-id="${id}"]`), `${kbLayout} 缺 ${id}`).toBeTruthy();
    }
  }
});

test("大写键帽跟随：Shift 按下后字母键帽显示大写，打一个键后回小写", async () => {
  const { container } = render(Keyboard, {
    props: { onText: vi.fn(), onCommand: vi.fn(), kbLayout: "layered" },
  });
  const capText = (id: string) =>
    (container.querySelector(`[data-key-id="${id}"] .main`) as HTMLElement)?.textContent;
  expect(capText("a")).toBe("a");
  const shift = container.querySelector('[data-key-id="Shift"]') as HTMLElement;
  await fireEvent.pointerDown(shift);
  await fireEvent.pointerUp(shift);
  expect(capText("a"), "Shift armed 时键帽应大写").toBe("A");
  const s = container.querySelector('[data-key-id="s"]') as HTMLElement;
  await fireEvent.pointerDown(s);
  await fireEvent.pointerUp(s);
  expect(capText("a"), "armed 被消耗后应回小写").toBe("a");
});

test("大写键帽跟随在 classic 下同样生效（Caps 锁定不自动释放）", async () => {
  const { container } = render(Keyboard, { props: { onText: vi.fn(), onCommand: vi.fn() } });
  const capText = (id: string) =>
    (container.querySelector(`[data-key-id="${id}"] .main`) as HTMLElement)?.textContent;
  const caps = container.querySelector('[data-key-id="Caps"]') as HTMLElement;
  await fireEvent.pointerDown(caps);  // off -> armed
  await fireEvent.pointerUp(caps);
  expect(capText("a")).toBe("A");
});

// ---- flick 上滑手势 ----
// 既有 helper 只塞 clientX（jsdom 没有原生 PointerEvent）。上滑判定要 Y，补一个。
function pointerEventXY(type: string, clientX: number, clientY: number): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "clientX", { value: clientX });
  Object.defineProperty(ev, "clientY", { value: clientY });
  return ev;
}

test("flick：在键上向上滑超过阈值，发出的是角标字符而不是字母", async () => {
  const onText = vi.fn();
  const { container } = render(Keyboard, {
    props: { onText, onCommand: vi.fn(), kbLayout: "flick" },
  });
  const q = container.querySelector('[data-key-id="q"]') as HTMLElement;
  q.dispatchEvent(pointerEventXY("pointerdown", 100, 200));
  q.dispatchEvent(pointerEventXY("pointermove", 100, 170));  // 上滑 30px > 22
  q.dispatchEvent(pointerEventXY("pointerup", 100, 170));
  expect(onText).toHaveBeenCalledWith("1");
  expect(onText).not.toHaveBeenCalledWith("q");
});

test("flick：滑动距离不够（10px）仍然是普通轻点，出字母", async () => {
  const onText = vi.fn();
  const { container } = render(Keyboard, {
    props: { onText, onCommand: vi.fn(), kbLayout: "flick" },
  });
  const q = container.querySelector('[data-key-id="q"]') as HTMLElement;
  q.dispatchEvent(pointerEventXY("pointerdown", 100, 200));
  q.dispatchEvent(pointerEventXY("pointermove", 100, 190));  // 只 10px < 22
  q.dispatchEvent(pointerEventXY("pointerup", 100, 190));
  expect(onText).toHaveBeenCalledWith("q");
});

// 下滑（12 期补全）：只有上滑时 flick 打不出 16 个符号（`!` `?` `@` `{` `}` 等
// shell 常用字符）。多开一个方向就多 26 个位，够补齐还有富余。
test("flick：向下滑超过阈值，发出的是左下角标字符", async () => {
  const onText = vi.fn();
  const { container } = render(Keyboard, {
    props: { onText, onCommand: vi.fn(), kbLayout: "flick" },
  });
  const q = container.querySelector('[data-key-id="q"]') as HTMLElement;
  q.dispatchEvent(pointerEventXY("pointerdown", 100, 200));
  q.dispatchEvent(pointerEventXY("pointermove", 100, 240));  // 下滑 40px > 22
  q.dispatchEvent(pointerEventXY("pointerup", 100, 240));
  expect(onText).toHaveBeenCalledWith("!");
  expect(onText).not.toHaveBeenCalledWith("q");
  expect(onText).not.toHaveBeenCalledWith("1");
});

// 10 个键刻意没配 down（它们 up 的 shift 位已在别处占位）。这些键下滑必须**退化
// 成轻点**出字母，而不是静默吞掉——吞掉的话用户滑歪一点就丢一个字符，且毫无反馈。
test("flick：没配 down 的键（r）下滑退化为轻点，出字母", async () => {
  const onText = vi.fn();
  const { container } = render(Keyboard, {
    props: { onText, onCommand: vi.fn(), kbLayout: "flick" },
  });
  const r = container.querySelector('[data-key-id="r"]') as HTMLElement;
  r.dispatchEvent(pointerEventXY("pointerdown", 100, 200));
  r.dispatchEvent(pointerEventXY("pointermove", 100, 240));  // 下滑 40px
  r.dispatchEvent(pointerEventXY("pointerup", 100, 240));
  expect(onText).toHaveBeenCalledWith("r");
});

test("flick：下滑距离不够（10px）仍然是普通轻点，出字母", async () => {
  const onText = vi.fn();
  const { container } = render(Keyboard, {
    props: { onText, onCommand: vi.fn(), kbLayout: "flick" },
  });
  const q = container.querySelector('[data-key-id="q"]') as HTMLElement;
  q.dispatchEvent(pointerEventXY("pointerdown", 100, 200));
  q.dispatchEvent(pointerEventXY("pointermove", 100, 210));  // 只 10px < 22
  q.dispatchEvent(pointerEventXY("pointerup", 100, 210));
  expect(onText).toHaveBeenCalledWith("q");
});

// 与上滑同理（那条是「先蹦字母再出符号」的真机 bug 守门人）：下滑走的是同一套
// 「抬手才结算」路径，按住期间一个字节都不该出去。
test("flick：下滑不该先送出字母", async () => {
  const onText = vi.fn();
  const { container } = render(Keyboard, {
    props: { onText, onCommand: vi.fn(), kbLayout: "flick" },
  });
  const q = container.querySelector('[data-key-id="q"]') as HTMLElement;
  q.dispatchEvent(pointerEventXY("pointerdown", 100, 200));
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
  expect(onText).not.toHaveBeenCalled();          // 按住期间静默
  q.dispatchEvent(pointerEventXY("pointermove", 100, 240));
  q.dispatchEvent(pointerEventXY("pointerup", 100, 240));
  expect(onText).toHaveBeenCalledTimes(1);
  expect(onText).toHaveBeenCalledWith("!");
});

// 上滑那条已有同款守门人。下滑同样必须跨过 rAF 才算数：真人滑完 22px 要 50ms 以上。
test("flick：等 rAF 跑完之后再下滑，仍然出符号", async () => {
  const onText = vi.fn();
  const { container } = render(Keyboard, {
    props: { onText, onCommand: vi.fn(), kbLayout: "flick" },
  });
  const q = container.querySelector('[data-key-id="q"]') as HTMLElement;
  q.dispatchEvent(pointerEventXY("pointerdown", 100, 200));
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
  q.dispatchEvent(pointerEventXY("pointermove", 100, 240));
  q.dispatchEvent(pointerEventXY("pointerup", 100, 240));
  expect(onText).toHaveBeenCalledWith("!");
  expect(onText).not.toHaveBeenCalledWith("q");
});

test("classic / layered 下滑不改变行为（手势只在 flick 生效）", async () => {
  for (const kbLayout of [undefined, "layered"] as const) {
    const onText = vi.fn();
    const { container, unmount } = render(Keyboard, {
      props: { onText, onCommand: vi.fn(), ...(kbLayout ? { kbLayout } : {}) },
    });
    const q = container.querySelector('[data-key-id="q"]') as HTMLElement;
    q.dispatchEvent(pointerEventXY("pointerdown", 100, 200));
    q.dispatchEvent(pointerEventXY("pointermove", 100, 240));
    q.dispatchEvent(pointerEventXY("pointerup", 100, 240));
    expect(onText, `${kbLayout ?? "classic"} 下滑行为被改了`).toHaveBeenCalledWith("q");
    unmount();
  }
});

test("flick：横向先越阈（12px）判为滑动取消，什么都不发", async () => {
  const onText = vi.fn();
  const { container } = render(Keyboard, {
    props: { onText, onCommand: vi.fn(), kbLayout: "flick" },
  });
  const q = container.querySelector('[data-key-id="q"]') as HTMLElement;
  q.dispatchEvent(pointerEventXY("pointerdown", 100, 200));
  q.dispatchEvent(pointerEventXY("pointermove", 130, 198));  // 横 30 / 竖 2
  q.dispatchEvent(pointerEventXY("pointerup", 130, 198));
  expect(onText).not.toHaveBeenCalled();
});

test("classic 下上滑不改变行为（手势只在 flick 生效）", async () => {
  const onText = vi.fn();
  const { container } = render(Keyboard, {
    props: { onText, onCommand: vi.fn() },   // 默认 classic
  });
  const q = container.querySelector('[data-key-id="q"]') as HTMLElement;
  q.dispatchEvent(pointerEventXY("pointerdown", 100, 200));
  q.dispatchEvent(pointerEventXY("pointermove", 100, 170));
  q.dispatchEvent(pointerEventXY("pointerup", 100, 170));
  expect(onText).toHaveBeenCalledWith("q");
});

test("flick：没有 up 的键（Shift/Backspace）上滑等同轻点", async () => {
  const onText = vi.fn();
  const { container } = render(Keyboard, {
    props: { onText, onCommand: vi.fn(), kbLayout: "flick" },
  });
  const bs = container.querySelector('[data-key-id="Backspace"]') as HTMLElement;
  bs.dispatchEvent(pointerEventXY("pointerdown", 100, 200));
  bs.dispatchEvent(pointerEventXY("pointermove", 100, 160));
  bs.dispatchEvent(pointerEventXY("pointerup", 100, 160));
  expect(onText).toHaveBeenCalledWith("\x7f");
});

// 上面几条 flick 用例都是同步派发 pointerdown→move→up，那是 jsdom 的时间尺度，
// 不是手指的：真人滑完 22px 要 50ms 以上，中间隔着好几帧。而 keyDown 排的那个
// rAF 会在第一帧后清掉 pendingKey——若把上滑判定挂在 pendingKey 上，同步测试
// 照样全绿，真机上却永远滑不出符号（heldKey 就是为此存在的）。
// 这条用例专门跨过那一帧，是该实现的守门人。
test("flick：等 rAF 跑完（真人手指的时间尺度）之后再上滑，仍然出符号", async () => {
  const onText = vi.fn();
  const { container } = render(Keyboard, {
    props: { onText, onCommand: vi.fn(), kbLayout: "flick" },
  });
  const q = container.querySelector('[data-key-id="q"]') as HTMLElement;
  q.dispatchEvent(pointerEventXY("pointerdown", 100, 200));
  // 让 keyDown 排的 rAF 真正执行：这一刻 pendingKey 已被清空、首发字节已送出
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
  onText.mockClear();   // 首发的 "q" 是既定行为（长按语义），本条只看滑动的结果
  q.dispatchEvent(pointerEventXY("pointermove", 100, 170));  // 上滑 30px > 22
  q.dispatchEvent(pointerEventXY("pointerup", 100, 170));
  expect(onText).toHaveBeenCalledWith("1");
});

// ---- 大键位的两条尺寸约束（源码级防回潮）----
// jsdom 不做真实布局，getBoundingClientRect 一律返回 0，尺寸只能从 CSS 源码断言。
// 这两条都是真机上一眼能看出、但改别处极易碰坏的约束，各自都返工过一轮。
test("大键位：esc/tab 的尺寸下限写成 px，不能退回 em", () => {
  const css = readFileSync(resolve(__dirname, "./Keyboard.svelte"), "utf8");
  const block = css.match(/\.funcrow \.key\.fnk,[\s\S]*?\}/)?.[0] ?? "";
  expect(block, "esc/tab 规则块没找到，选择器被改过了？").toMatch(/min-width:\s*\d+px/);
  expect(block).toMatch(/min-height:\s*\d+px/);
  // em 会跟着 font-size:0.62rem 缩水，算下来 30×23 —— 比字母键（36×31）还小，
  // 而 esc/tab 是终端里最常按的键之一。
  expect(block, "尺寸退回 em 会让 esc/tab 比字母键还小").not.toMatch(/min-(width|height):\s*[\d.]+em/);
});

test("大键位：行高封顶 1.5 倍键宽，键不会被拉成竖条", () => {
  const css = readFileSync(resolve(__dirname, "./Keyboard.svelte"), "utf8");
  const block = css.match(/\.rows\.big \.row \{[\s\S]*?\}/)?.[0] ?? "";
  expect(block, ".rows.big .row 规则块没找到").toBeTruthy();
  expect(block, "行高必须有封顶，否则 flex:1 会把键抽成细长竖条").toMatch(/max-height:/);
  expect(block, "封顶按视口宽算：max-height 里的百分比是相对父元素高度的，写 % 会得到无关的值")
    .toMatch(/100vw/);
  expect(block).toMatch(/\*\s*1\.5/);
});

// 真机反馈（12 期）：按住一个键上滑，会先蹦出 1 到多个字母，然后才出符号。
// 试过用定时器把首发推后，不成——那只是把问题推后：按住超过判定窗口再滑，
// 字母照样先出。只要「按下」这一刻就决定输出，就永远分不清轻点还是上滑，
// 因为两个动作的开头完全一样。最终改成 up 键抬手才输入。
test("flick：上滑不该先送出字母（真机反馈：先蹦字母再出符号）", async () => {
  const onText = vi.fn();
  const { container } = render(Keyboard, {
    props: { onText, onCommand: vi.fn(), kbLayout: "flick" },
  });
  const q = container.querySelector('[data-key-id="q"]') as HTMLElement;
  q.dispatchEvent(pointerEventXY("pointerdown", 100, 200));
  expect(onText, "按下时不该送出任何字节").not.toHaveBeenCalled();
  q.dispatchEvent(pointerEventXY("pointermove", 100, 170));  // 上滑 30px
  q.dispatchEvent(pointerEventXY("pointerup", 100, 170));
  expect(onText).toHaveBeenCalledTimes(1);
  expect(onText).toHaveBeenCalledWith("1");
});

test("flick：普通轻点仍然出字母，抬手立即结算不等判定窗口", async () => {
  vi.useFakeTimers();
  try {
    const onText = vi.fn();
    const { container } = render(Keyboard, {
      props: { onText, onCommand: vi.fn(), kbLayout: "flick" },
    });
    const q = container.querySelector('[data-key-id="q"]') as HTMLElement;
    q.dispatchEvent(pointerEventXY("pointerdown", 100, 200));
    q.dispatchEvent(pointerEventXY("pointerup", 100, 200));   // 立刻抬手，没等 120ms
    expect(onText, "轻点必须立即出字母，用户感觉不到判定窗口").toHaveBeenCalledWith("q");
  } finally {
    vi.useRealTimers();
  }
});

// 带上滑的键是**抬手才输入**：按住期间一个字节都不发，抬手时手指走过多远
// 已成定局，越过阈值就是符号、没越过就是字母，不需要猜。
// 这也顺带取消了这些键的长按连发（连发要在按住期间就往外发，与上面直接冲突）。
test("flick：带上滑的键按住不动，一个字节都不发；抬手才出字母", async () => {
  vi.useFakeTimers();
  try {
    const onText = vi.fn();
    const { container } = render(Keyboard, {
      props: { onText, onCommand: vi.fn(), kbLayout: "flick" },
    });
    const q = container.querySelector('[data-key-id="q"]') as HTMLElement;
    q.dispatchEvent(pointerEventXY("pointerdown", 100, 200));
    vi.advanceTimersByTime(400 + 60 * 10);  // 远超连发的启动延迟
    expect(onText, "按住期间不该发任何字节").not.toHaveBeenCalled();
    q.dispatchEvent(pointerEventXY("pointerup", 100, 200));
    expect(onText).toHaveBeenCalledTimes(1);
    expect(onText).toHaveBeenCalledWith("q");
  } finally {
    vi.useRealTimers();
  }
});

// 用户报的原始现象：按住上滑，先蹦字母再出符号。按住多久都不该改变结论。
test("flick：按住很久再上滑，只出符号，不先蹦字母", async () => {
  vi.useFakeTimers();
  try {
    const onText = vi.fn();
    const { container } = render(Keyboard, {
      props: { onText, onCommand: vi.fn(), kbLayout: "flick" },
    });
    const q = container.querySelector('[data-key-id="q"]') as HTMLElement;
    q.dispatchEvent(pointerEventXY("pointerdown", 100, 200));
    vi.advanceTimersByTime(1000);           // 按住整整一秒才开始滑
    expect(onText, "按住期间不该有任何输出").not.toHaveBeenCalled();
    q.dispatchEvent(pointerEventXY("pointermove", 100, 170));
    q.dispatchEvent(pointerEventXY("pointerup", 100, 170));
    expect(onText).toHaveBeenCalledTimes(1);
    expect(onText).toHaveBeenCalledWith("1");
  } finally {
    vi.useRealTimers();
  }
});

// 反面：没有上滑字符的键（退格、方向键、space）连发照常——那才是真正需要
// 连打的键，删一长串路径全靠它。
test("flick：没有上滑的键（退格）仍然长按连发", async () => {
  vi.useFakeTimers();
  try {
    const onText = vi.fn();
    const { container } = render(Keyboard, {
      props: { onText, onCommand: vi.fn(), kbLayout: "flick" },
    });
    const bs = container.querySelector('[data-key-id="Backspace"]') as HTMLElement;
    bs.dispatchEvent(pointerEventXY("pointerdown", 100, 200));
    vi.advanceTimersByTime(16);            // rAF 分支：首发照旧一帧就走
    expect(onText).toHaveBeenCalledWith("\x7f");
    const first = onText.mock.calls.length;
    vi.advanceTimersByTime(400 + 60 * 5);  // 启动延迟 + 5 个连发周期
    expect(onText.mock.calls.length, "退格必须连发").toBeGreaterThan(first);
  } finally {
    vi.useRealTimers();
  }
});

test("layered / classic 的首发不受判定窗口影响（没有 up 就没有上滑）", async () => {
  for (const kbLayout of ["classic", "layered"] as const) {
    const onText = vi.fn();
    const { container, unmount } = render(Keyboard, {
      props: { onText, onCommand: vi.fn(), kbLayout },
    });
    const q = container.querySelector('[data-key-id="q"]') as HTMLElement;
    q.dispatchEvent(pointerEventXY("pointerdown", 100, 200));
    q.dispatchEvent(pointerEventXY("pointerup", 100, 200));
    expect(onText, `${kbLayout} 的轻点应照常出字母`).toHaveBeenCalledWith("q");
    unmount();
  }
});

// layered 的字母键没有 up（数字符号在第二层，不靠上滑），所以连发照常。
// 「取消连发」只针对带上滑的键，不是对所有大布局一刀切。
test("layered：字母键没有上滑，长按连发照常", async () => {
  vi.useFakeTimers();
  try {
    const onText = vi.fn();
    const { container } = render(Keyboard, {
      props: { onText, onCommand: vi.fn(), kbLayout: "layered" },
    });
    const q = container.querySelector('[data-key-id="q"]') as HTMLElement;
    q.dispatchEvent(pointerEventXY("pointerdown", 100, 200));
    vi.advanceTimersByTime(16);
    const first = onText.mock.calls.length;
    expect(first).toBeGreaterThan(0);
    vi.advanceTimersByTime(400 + 60 * 5);
    expect(onText.mock.calls.length, "layered 字母键应连发").toBeGreaterThan(first);
  } finally {
    vi.useRealTimers();
  }
});

// keyDown 开头有个「清理同键陈旧状态」的 keyUp(id) 调用。带上滑的键在 keyUp
// 里会「抬手结算」发字母，若不先摘掉 heldKey，同一个键重复按下（真机上丢了
// pointerup 就会这样）会凭空多打一个字。
test("flick：同一个键连续按下两次（丢了 pointerup）不该凭空多出字母", async () => {
  const onText = vi.fn();
  const { container } = render(Keyboard, {
    props: { onText, onCommand: vi.fn(), kbLayout: "flick" },
  });
  const q = container.querySelector('[data-key-id="q"]') as HTMLElement;
  q.dispatchEvent(pointerEventXY("pointerdown", 100, 200));
  q.dispatchEvent(pointerEventXY("pointerdown", 100, 200));  // pointerup 丢了
  expect(onText, "重复按下不该产生输出").not.toHaveBeenCalled();
  q.dispatchEvent(pointerEventXY("pointerup", 100, 200));
  expect(onText).toHaveBeenCalledTimes(1);
});

// 横滑取消对带上滑的键同样要生效。这些键不设 pendingKey，所以取消逻辑
// 必须认 heldKey——只看 pendingKey 会让整条路径对它们失效（横滑走了，
// 抬手时照样结算出一个字母）。
test("flick：横滑取消后抬手，不该结算出字母", async () => {
  const onText = vi.fn();
  const { container } = render(Keyboard, {
    props: { onText, onCommand: vi.fn(), kbLayout: "flick" },
  });
  const q = container.querySelector('[data-key-id="q"]') as HTMLElement;
  q.dispatchEvent(pointerEventXY("pointerdown", 100, 200));
  q.dispatchEvent(pointerEventXY("pointermove", 140, 198));  // 横移 40px
  q.dispatchEvent(pointerEventXY("pointerup", 140, 198));
  expect(onText).not.toHaveBeenCalled();
});

// 副字符（角标）在两套大布局里都摆右上角：叠放会让键内容需要 32px 高，而键盘区
// 被分割条压缩时行只有 25px，.key 的 overflow:hidden 会切掉它。规则写在
// `.rows.big` 上而不是 `.rows.big.flick`，两套布局才会一起生效。
test("大键位：副字符规则作用于整个 .rows.big，不是只有 flick", () => {
  const css = readFileSync(resolve(__dirname, "./Keyboard.svelte"), "utf8");
  expect(css, "只限定 flick 会让 layered 符号层继续叠放")
    .not.toMatch(/\.rows\.big\.flick\s+\.key\.has-up/);
  // 绝对定位是关键：叠放会让键内容需要 32px，而压缩时行只有 25px，
  // .key 的 overflow:hidden 会把角标切掉。
  const block = css.match(/\.rows\.big \.key\.has-up \.up,[\s\S]*?\}/)?.[0] ?? "";
  expect(block, "副字符规则块没找到").toBeTruthy();
  expect(block).toMatch(/position:\s*absolute/);
  // 上滑在右上、下滑在左下——对角摆放。同侧会挤成一坨且分不清方向。
  expect(css).toMatch(/\.key\.has-up \.up \{[^}]*top:[^}]*right:/);
  expect(css).toMatch(/\.key\.has-down \.down \{[^}]*bottom:[^}]*left:/);
});

// layered 符号层按下 Shift 时主副字符**互换**（3/# → #/3）。摆到角上是样式，
// 互换是 keyLabel 的语义，两者互不影响——这条钉住互换没被样式改动带偏。
test("layered 符号层：Shift 让主副字符互换，与角标位置无关", async () => {
  const { container } = render(Keyboard, {
    props: { onText: vi.fn(), onCommand: vi.fn(), kbLayout: "layered" },
  });
  const layer = container.querySelector('[data-key-id="__layer"]') as HTMLElement;
  await fireEvent.pointerDown(layer);
  await fireEvent.pointerUp(layer);
  const cap = () => {
    const k = container.querySelector('[data-key-id="3"]') as HTMLElement;
    return { main: k.querySelector(".main")?.textContent, up: k.querySelector(".up")?.textContent };
  };
  expect(cap()).toEqual({ main: "3", up: "#" });
  const shift = container.querySelector('.rows [data-key-id="Shift"]') as HTMLElement;
  await fireEvent.pointerDown(shift);
  await fireEvent.pointerUp(shift);
  expect(cap(), "Shift 按下后应互换").toEqual({ main: "#", up: "3" });
});

// 13 期需求 4：大布局功能行 Tab 放最左（它比 Esc 更高频）。
// 只动 layered / flick 两套大布局——classic 的功能行本来就没有 Tab
//（它的 Tab 在主键区 Q 行最左，照抄笔记本键盘），且 classic 一字不变。
test("layered / flick：功能行第一个键是 Tab，第二个才是 Esc", () => {
  for (const kbLayout of ["layered", "flick"] as const) {
    const { container } = render(Keyboard, {
      props: { onText: vi.fn(), onCommand: vi.fn(), kbLayout },
    });
    const keys = Array.from(container.querySelectorAll(".funcrow > [data-key-id]"))
      .map((b) => b.getAttribute("data-key-id"));
    expect(keys, `${kbLayout} 功能行顺序不对`).toEqual(["Tab", "Esc"]);
  }
});

test("classic：功能行只有 Esc，没有 Tab（既有布局零改动）", () => {
  const { container } = render(Keyboard, {
    props: { onText: vi.fn(), onCommand: vi.fn() },
  });
  const keys = Array.from(container.querySelectorAll(".funcrow > [data-key-id]"))
    .map((b) => b.getAttribute("data-key-id"));
  expect(keys).toEqual(["Esc"]);
});

test("换位后 Tab 仍发 \\x09、Esc 仍发 \\x1b", async () => {
  const onText = vi.fn();
  const { container } = render(Keyboard, {
    props: { onText, onCommand: vi.fn(), kbLayout: "layered" },
  });
  const tab = container.querySelector('.funcrow [data-key-id="Tab"]') as HTMLElement;
  await fireEvent.pointerDown(tab);
  await fireEvent.pointerUp(tab);
  expect(onText).toHaveBeenCalledWith("\x09");
  const esc = container.querySelector('.funcrow [data-key-id="Esc"]') as HTMLElement;
  await fireEvent.pointerDown(esc);
  await fireEvent.pointerUp(esc);
  expect(onText).toHaveBeenCalledWith("\x1b");
});


// 【2026-08-28 误锁陷阱】轻点不再进入 locked（旧三态循环里 Ctrl+C 前多按一下
// Ctrl 就把修饰键锁死，之后所有字母以 1 字节控制码发出——cc 输入框打不进字
// 的真根因）。钉住组件层三件事：连点不锁、长按 500ms 锁、锁定芯片出现且轻点可解。
test("修饰键连点两下=开再关不锁死；长按 500ms 才锁定并出芯片", async () => {
  vi.useFakeTimers();
  const { onText, r } = openOps();
  const ctrl = r.container.querySelector('[data-key-id="Ctrl"]')!;
  const chip = () => r.container.querySelector(".modlock-chip");

  // 两次轻点：armed → off，没有芯片，也没发任何字节。
  await fireEvent.pointerDown(ctrl); await vi.advanceTimersByTimeAsync(100); await fireEvent.pointerUp(ctrl);
  await fireEvent.pointerDown(ctrl); await vi.advanceTimersByTimeAsync(100); await fireEvent.pointerUp(ctrl);
  expect(onText).not.toHaveBeenCalled();
  expect(chip()).toBeNull();

  // 长按 600ms：锁定 + 芯片出现。
  await fireEvent.pointerDown(ctrl); await vi.advanceTimersByTimeAsync(600); await fireEvent.pointerUp(ctrl);
  expect(chip()?.textContent).toContain("Ctrl");

  // 轻点锁定键：解除，芯片消失。
  await fireEvent.pointerDown(ctrl); await vi.advanceTimersByTimeAsync(50); await fireEvent.pointerUp(ctrl);
  expect(chip()).toBeNull();
  vi.useRealTimers();
});
