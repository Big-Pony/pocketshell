import { test, expect, describe } from "vitest";
import { fileTabId, openFileTab, closeFileTab, cycle, stepClamp, appendOrder, removeOrder, visibleOrder, filePathFromTabId, stepTap, TAP_RESET, TAP_WINDOW_MS, type TopTab, type TapState } from "./top-tabs";

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
