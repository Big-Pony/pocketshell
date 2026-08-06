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

test("normal state shows hint chips and tapping one calls onHint", async () => {
  const onHint = vi.fn();
  render(Keyboard, {
    props: { onText: () => {}, onCommand: () => {}, hints: ["git status", "ls -la"], onHint },
  });
  const chip = screen.getByText("git status");
  await fireEvent.pointerDown(chip);
  expect(onHint).toHaveBeenCalledWith("git status");
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

test("flick：向下滑不触发（只认向上）", async () => {
  const onText = vi.fn();
  const { container } = render(Keyboard, {
    props: { onText, onCommand: vi.fn(), kbLayout: "flick" },
  });
  const q = container.querySelector('[data-key-id="q"]') as HTMLElement;
  q.dispatchEvent(pointerEventXY("pointerdown", 100, 200));
  q.dispatchEvent(pointerEventXY("pointermove", 100, 240));  // 下滑 40px
  q.dispatchEvent(pointerEventXY("pointerup", 100, 240));
  expect(onText).toHaveBeenCalledWith("q");
  expect(onText).not.toHaveBeenCalledWith("1");
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
