import { test, expect, describe } from "vitest";
import { fileTabId, openFileTab, closeFileTab, cycle, stepClamp, appendOrder, removeOrder, visibleOrder, filePathFromTabId, stepTap, TAP_RESET, TAP_WINDOW_MS, findTabByPath, replaceTabPath, openOrReuseFileTab, groupByKind, type TopTab, type TapState } from "./top-tabs";

test("fileTabId is stable per path+mode", () => {
  expect(fileTabId("/a.ts", "code")).toBe("file:code:/a.ts");
  expect(fileTabId("/a.ts", "diff")).not.toBe(fileTabId("/a.ts", "code"));
});

test("openFileTab appends once, dedupes on repeat", () => {
  let tabs: TopTab[] = [];
  tabs = openFileTab(tabs, "/a.ts", "code");
  tabs = openFileTab(tabs, "/a.ts", "code");
  expect(tabs.length).toBe(1);
  expect(tabs[0]).toMatchObject({ kind: "file", path: "/a.ts", mode: "code", title: "a.ts" });
});

test("closeFileTab removes by id", () => {
  let tabs: TopTab[] = openFileTab([], "/a.ts", "code");
  tabs = closeFileTab(tabs, fileTabId("/a.ts", "code"));
  expect(tabs.length).toBe(0);
});

test("cycle steps forward and wraps", () => {
  const order = ["s1", "s2", "file:code:/a.ts"];
  expect(cycle(order, "s1", 1)).toBe("s2");
  expect(cycle(order, "file:code:/a.ts", 1)).toBe("s1");
  expect(cycle(order, "s1", -1)).toBe("file:code:/a.ts");
});

test("stepClamp steps forward/back but does not wrap", () => {
  const order = ["s1", "s2", "s3"];
  expect(stepClamp(order, "s1", 1)).toBe("s2");
  expect(stepClamp(order, "s3", 1)).toBe("s3");   // clamped at end, no wrap
  expect(stepClamp(order, "s1", -1)).toBe("s1");  // clamped at start, no wrap
  expect(stepClamp([], "s1", 1)).toBe("s1");      // empty -> unchanged
});

describe("interleaved tab order", () => {
  test("appendOrder adds new ids and ignores duplicates", () => {
    expect(appendOrder(["a"], "b")).toEqual(["a", "b"]);
    expect(appendOrder(["a", "b"], "a")).toEqual(["a", "b"]);
  });
  test("removeOrder drops the id", () => {
    expect(removeOrder(["a", "b", "c"], "b")).toEqual(["a", "c"]);
  });
  test("visibleOrder keeps stored order, drops invalid, appends new extras", () => {
    const order = ["s1", "file:code:/x", "s2"];
    const valid = new Set(["s1", "s2", "s3", "file:code:/x"]);
    expect(visibleOrder(order, valid, ["s1", "s2", "s3"])).toEqual([
      "s1", "file:code:/x", "s2", "s3",
    ]);
  });
  test("visibleOrder removes ids no longer valid", () => {
    const order = ["s1", "file:code:/x", "s2"];
    const valid = new Set(["s1", "s2"]);
    expect(visibleOrder(order, valid, ["s1", "s2"])).toEqual(["s1", "s2"]);
  });
});

test("filePathFromTabId returns the path for a file tab, null otherwise", () => {
  let tabs = openFileTab([], "/Users/me/proj/a.ts", "code");
  const id = fileTabId("/Users/me/proj/a.ts", "code");
  expect(filePathFromTabId(tabs, id)).toBe("/Users/me/proj/a.ts");
  expect(filePathFromTabId(tabs, "nope")).toBeNull();
  expect(filePathFromTabId([{ kind: "term", id: "s1", title: "s1" }], "s1")).toBeNull();
});

describe("stepTap gesture FSM", () => {
  const W = TAP_WINDOW_MS;
  // Drive a sequence of taps on one tab, returning the action types in order.
  function run(kind: "term" | "file", times: number[], dragged: boolean[] = []) {
    let s: TapState = TAP_RESET;
    const actions: string[] = [];
    times.forEach((t, i) => {
      const r = stepTap(s, { id: "x", kind, t, dragged: dragged[i] ?? false });
      s = r.state;
      actions.push(r.action.type);
    });
    return actions;
  }

  test("single tap on a file tab selects", () => {
    expect(run("file", [0])).toEqual(["select"]);
  });

  test("double tap on a file tab defers close (awaits a 3rd)", () => {
    expect(run("file", [0, 100])).toEqual(["select", "deferClose"]);
  });

  test("triple tap on a file tab copies, then resets", () => {
    expect(run("file", [0, 100, 200])).toEqual(["select", "deferClose", "copy"]);
  });

  test("double tap on a term tab closes immediately (no defer)", () => {
    expect(run("term", [0, 100])).toEqual(["select", "closeNow"]);
  });

  test("term tab never copies; a 3rd tap after reset is a fresh select", () => {
    // count resets after closeNow, so the 3rd tap starts a new sequence.
    expect(run("term", [0, 100, 150])).toEqual(["select", "closeNow", "select"]);
  });

  test("taps spaced beyond the window are separate selects", () => {
    expect(run("file", [0, W + 10])).toEqual(["select", "select"]);
  });

  test("a dragged pointer-up is never a tap and breaks the sequence", () => {
    // tap1 select, tap2 is a drag -> none + reset, tap3 is a fresh select.
    expect(run("file", [0, 100, 150], [false, true, false])).toEqual(["select", "none", "select"]);
  });

  test("tapping a different tab resets the count to 1 (select)", () => {
    let s: TapState = TAP_RESET;
    let r = stepTap(s, { id: "a", kind: "file", t: 0, dragged: false });
    expect(r.action.type).toBe("select");
    r = stepTap(r.state, { id: "b", kind: "file", t: 50, dragged: false });
    expect(r.action.type).toBe("select"); // different id -> count 1
  });

  test("copy resets so a following tap starts a new select", () => {
    expect(run("file", [0, 100, 200, 250])).toEqual(["select", "deferClose", "copy", "select"]);
  });
});

describe("in-place file tab navigation helpers", () => {
  test("findTabByPath matches on path+mode, not id", () => {
    let tabs: TopTab[] = [];
    tabs = openFileTab(tabs, "/proj/a.ts", "code");
    expect(findTabByPath(tabs, "/proj/a.ts", "code")?.path).toBe("/proj/a.ts");
    expect(findTabByPath(tabs, "/proj/a.ts", "diff")).toBeUndefined();
    expect(findTabByPath(tabs, "/proj/missing.ts", "code")).toBeUndefined();
  });

  test("replaceTabPath rewrites path+title but keeps the id stable", () => {
    let tabs: TopTab[] = openFileTab([], "/proj/a.ts", "code");
    const id = tabs[0].id;
    tabs = replaceTabPath(tabs, id, "/proj/sub/b.ts");
    expect(tabs.length).toBe(1);
    expect(tabs[0].id).toBe(id); // id unchanged (stable slot)
    expect(tabs[0]).toMatchObject({ path: "/proj/sub/b.ts", title: "b.ts", mode: "code" });
  });

  test("openOrReuseFileTab reuses an existing slot by path (no new tab)", () => {
    let tabs: TopTab[] = openFileTab([], "/proj/a.ts", "code");
    const first = openOrReuseFileTab(tabs, "/proj/a.ts", "code");
    expect(first.tabs.length).toBe(1);
    expect(first.id).toBe(tabs[0].id);
  });

  test("openOrReuseFileTab uniquifies a colliding id left by an in-place swap", () => {
    // Slot opened as /A, then navigated in place to /B: its id still encodes /A.
    let tabs: TopTab[] = openFileTab([], "/A", "code");
    const staleId = tabs[0].id; // "file:code:/A"
    tabs = replaceTabPath(tabs, staleId, "/B");
    // Now open /A from the panel: base id "file:code:/A" collides with the stale slot.
    const r = openOrReuseFileTab(tabs, "/A", "code");
    expect(r.tabs.length).toBe(2);
    expect(r.id).not.toBe(staleId);      // fresh, collision-free id
    const ids = new Set(r.tabs.map((t) => t.id));
    expect(ids.size).toBe(2);            // no duplicate keys
  });
});

test("groupByKind 终端在前文件在后，两组各自倒序", () => {
  const order = ["t1", "file:code:/a", "t2", "file:code:/b"];
  const fileIds = new Set(["file:code:/a", "file:code:/b"]);
  expect(groupByKind(order, fileIds)).toEqual(["t2", "t1", "file:code:/b", "file:code:/a"]);
});

test("groupByKind 空输入返回空数组", () => {
  expect(groupByKind([], new Set())).toEqual([]);
});

test("groupByKind 纯终端只做倒序", () => {
  expect(groupByKind(["a", "b", "c"], new Set())).toEqual(["c", "b", "a"]);
});

test("groupByKind 纯文件只做倒序", () => {
  const ids = new Set(["f1", "f2"]);
  expect(groupByKind(["f1", "f2"], ids)).toEqual(["f2", "f1"]);
});

test("groupByKind 不在 fileIds 中的 id 归为终端组", () => {
  // id 形如 file:… 但不在集合里（例如已关闭的陈旧 id）仍按终端处理，
  // 判定依据只有集合，不看字符串前缀
  const out = groupByKind(["file:code:/x", "t1"], new Set());
  expect(out).toEqual(["t1", "file:code:/x"]);
});

test("groupByKind 不修改入参", () => {
  const order = ["t1", "t2"];
  groupByKind(order, new Set());
  expect(order).toEqual(["t1", "t2"]);
});

// ── 2026-08-18 幽灵 attach（docs/需求/2026-08-18-多会话空白与输出丢失，优先级 3）──
//
// toBackground() 此前**没有** removeOrder，而同语义的 closeTopTab() 有。后果链：
// 后台化会话永久留在 tabOrder → 落进 localStorage → 重进时 App 的一次性重连循环
// 只过滤 file: 前缀与 alive、**不过滤 backgrounded** → 无条件 conn.attach(id)。
// 而 topSessions **排除** backgrounded，这些会话根本不挂 TerminalView ——
// 给一个没有任何渲染宿主的会话订阅了实时流，字节 100% 无人消费，纯粹抢带宽。
// 用户后台过的会话越多，幽灵流量越大。
//
// 两条路径共用同一个纯函数，对称性因此是结构性的而不是靠人记住。
import { backgroundTab, reattachOnRestore } from "./top-tabs";

describe("backgroundTab", () => {
  test("把 id 移出 tabOrder —— 与 closeTopTab 同语义", () => {
    const r = backgroundTab(["a", "b", "c"], new Set(["z"]), "b");
    expect(r.tabOrder).toEqual(["a", "c"]);
  });

  test("把 id 放进 backgrounded，且返回新的 Set（Svelte 的 $state 靠新引用触发）", () => {
    const before = new Set(["z"]);
    const r = backgroundTab(["a"], before, "a");
    expect([...r.backgrounded].sort()).toEqual(["a", "z"]);
    expect(r.backgrounded).not.toBe(before);
  });

  test("重复后台化幂等", () => {
    const once = backgroundTab(["a", "b"], new Set(), "a");
    const twice = backgroundTab(once.tabOrder, once.backgrounded, "a");
    expect(twice.tabOrder).toEqual(["b"]);
    expect([...twice.backgrounded]).toEqual(["a"]);
  });
});

describe("reattachOnRestore（重进时该给谁补 attach）", () => {
  test("排除 file: 前缀与已死会话 —— 保持原有行为", () => {
    const ids = reattachOnRestore(["file:/x", "live", "dead"], new Set(["live"]), new Set());
    expect(ids).toEqual(["live"]);
  });

  test("★ 排除后台化会话 —— 它们不挂 TerminalView，attach 来的字节无人消费", () => {
    const ids = reattachOnRestore(["fg", "bg"], new Set(["fg", "bg"]), new Set(["bg"]));
    expect(ids).toEqual(["fg"]);
  });

  test("存量用户的 localStorage 里已经有泄漏的 tabOrder，这条过滤同时治存量", () => {
    // 修 toBackground 只防新增；已经写进 localStorage 的那些要靠这里挡住。
    const ids = reattachOnRestore(["a", "b", "c"], new Set(["a", "b", "c"]), new Set(["b", "c"]));
    expect(ids).toEqual(["a"]);
  });
});
