import { describe, expect, test } from "vitest";
import { graceExpiryIsCurrent, stopStream, switchStream } from "./tab-stream-policy";

describe("switchStream", () => {
  test("keeps the previous terminal as grace when selecting another terminal", () => {
    expect(switchStream({ current: "A", grace: null }, "B")).toEqual({
      state: { current: "B", grace: "A" },
      stream: ["B", "A"],
      detachNow: [],
      scheduleDetach: "A",
    });
  });

  test("reactivates the grace terminal and gives the old current grace", () => {
    expect(switchStream({ current: "B", grace: "A" }, "A")).toEqual({
      state: { current: "A", grace: "B" },
      stream: ["A", "B"],
      detachNow: [],
      scheduleDetach: "B",
    });
  });

  test("immediately detaches old grace when selecting a third terminal", () => {
    expect(switchStream({ current: "B", grace: "A" }, "C")).toEqual({
      state: { current: "C", grace: "B" },
      stream: ["C", "B"],
      detachNow: ["A"],
      scheduleDetach: "B",
    });
  });

  test("keeps the current terminal as grace when selecting a file tab", () => {
    expect(switchStream({ current: "A", grace: null }, null)).toEqual({
      state: { current: null, grace: "A" },
      stream: ["A"],
      detachNow: [],
      scheduleDetach: "A",
    });
  });

  test("does nothing when selecting the already-current terminal", () => {
    expect(switchStream({ current: "A", grace: "B" }, "A")).toEqual({
      state: { current: "A", grace: "B" },
      stream: [],
      detachNow: [],
      scheduleDetach: null,
    });
  });

  test("never duplicates a terminal or keeps more than current plus grace", () => {
    const transition = switchStream({ current: "A", grace: "A" }, "B");

    expect(transition.stream).toEqual(["B", "A"]);
    expect(new Set(transition.stream).size).toBe(transition.stream.length);
    expect(transition.stream.length).toBeLessThanOrEqual(2);
  });
});

describe("graceExpiryIsCurrent", () => {
  const captured = { sessionId: "A", generation: 4 };

  test("accepts the current grace timer for an inactive streamed session", () => {
    expect(graceExpiryIsCurrent(captured, {
      state: { current: "B", grace: "A" },
      generation: 4,
      streaming: new Set(["B", "A"]),
    })).toBe(true);
  });

  test.each([
    ["renamed", { current: "B", grace: "renamed-A" }, new Set(["B", "renamed-A"])],
    ["closed", { current: "B", grace: null }, new Set(["B"])],
  ])("rejects a %s grace session", (_reason, state, streaming) => {
    expect(graceExpiryIsCurrent(captured, { state, generation: 4, streaming })).toBe(false);
  });

  test("rejects a reactivated grace session", () => {
    expect(graceExpiryIsCurrent(captured, {
      state: { current: "A", grace: "B" },
      generation: 4,
      streaming: new Set(["A", "B"]),
    })).toBe(false);
  });

  test("rejects a stale timer generation", () => {
    expect(graceExpiryIsCurrent(captured, {
      state: { current: "B", grace: "A" },
      generation: 5,
      streaming: new Set(["B", "A"]),
    })).toBe(false);
  });

  test("rejects a session that was already removed from the stream", () => {
    expect(graceExpiryIsCurrent(captured, {
      state: { current: "B", grace: "A" },
      generation: 4,
      streaming: new Set(["B"]),
    })).toBe(false);
  });
});

describe("App focus entry path projection", () => {
  test.each([
    ["click terminal -> terminal", { current: "A", grace: null }, "B", { current: "B", grace: "A" }, ["B", "A"]],
    ["Fn/swipe terminal -> terminal", { current: "A", grace: null }, "B", { current: "B", grace: "A" }, ["B", "A"]],
    ["terminal -> file", { current: "A", grace: null }, null, { current: null, grace: "A" }, ["A"]],
    ["file -> terminal", { current: null, grace: "A" }, "B", { current: "B", grace: null }, ["B"]],
    ["new terminal activation", { current: "A", grace: null }, "new", { current: "new", grace: "A" }, ["new", "A"]],
    ["close current and select successor", { current: null, grace: "B" }, "B", { current: "B", grace: null }, ["B"]],
    ["reopen background task", { current: null, grace: "A" }, "B", { current: "B", grace: null }, ["B"]],
  ] as const)("%s", (_path, previous, next, state, stream) => {
    const transition = switchStream(previous, next);
    expect(transition.state).toEqual(state);
    expect(transition.stream).toEqual(stream);
  });
});

describe("stopStream", () => {
  test("removes a current session from state and streaming before detaching it", () => {
    expect(stopStream({ current: "A", grace: "B" }, "A")).toEqual({
      state: { current: null, grace: "B" },
      stream: ["B"],
      detachNow: ["A"],
      preserveGraceTimer: false,
    });
  });

  test("removes a grace session from state and streaming before detaching it", () => {
    expect(stopStream({ current: "A", grace: "B" }, "B")).toEqual({
      state: { current: "A", grace: null },
      stream: ["A"],
      detachNow: ["B"],
      preserveGraceTimer: false,
    });
  });

  test("preserves the live grace timer when stopping an unrelated session", () => {
    const previous = { current: "A", grace: "B" };
    const stop = stopStream(previous, "C");

    expect(stop).toEqual({
      state: previous,
      stream: [],
      detachNow: ["C"],
      preserveGraceTimer: true,
    });
    expect(stop.state).toBe(previous);
  });
});
