import { test, expect } from "vitest";
import { fullscreenAction } from "./fullscreen";

const fakeDoc = (over: Partial<{ req: unknown; exit: unknown; el: unknown }> = {}) =>
  ({
    documentElement: { requestFullscreen: "req" in over ? over.req : () => {} },
    exitFullscreen: "exit" in over ? over.exit : () => {},
    fullscreenElement: "el" in over ? over.el : null,
  }) as unknown as Document;

test("enter when API present and not currently fullscreen", () => {
  expect(fullscreenAction(fakeDoc())).toBe("enter");
});

test("exit when API present and already fullscreen", () => {
  expect(fullscreenAction(fakeDoc({ el: {} }))).toBe("exit");
});

test("unsupported when requestFullscreen is missing (iOS Safari)", () => {
  expect(fullscreenAction(fakeDoc({ req: undefined }))).toBe("unsupported");
});

test("unsupported when exitFullscreen is missing", () => {
  expect(fullscreenAction(fakeDoc({ exit: undefined }))).toBe("unsupported");
});
