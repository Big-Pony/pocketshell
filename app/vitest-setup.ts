// Adds jest-dom matchers (toBeInTheDocument, toHaveTextContent, …) to vitest's
// expect, for component tests rendered via @testing-library/svelte.
import "@testing-library/jest-dom/vitest";
// Register the zh/en dictionaries (side effect of importing the i18n module)
// and pin the locale to zh so tests can keep asserting Chinese UI strings
// regardless of jsdom's en-US navigator.language.
import { init } from "svelte-i18n";
import "./src/lib/i18n";

init({ fallbackLocale: "zh", initialLocale: "zh" });

// jsdom ships no canvas implementation: `canvas.getContext('2d')` returns null
// (and logs a "Not implemented" notice). xterm's DOM renderer measures glyph
// widths through a canvas 2d context since @xterm/xterm 6.x (WidthCache), and
// wraps it in throwIfFalsy — so a null context turns every `term.open()` in a
// component test into an unhandled rejection.
//
// The measurements themselves are irrelevant here: jsdom has no layout engine,
// so every width would be 0 with or without this stub. It only needs to be
// non-null and to answer measureText, so the renderer can construct. Anything
// depending on REAL glyph metrics has to be verified in a browser, not jsdom.
if (typeof HTMLCanvasElement !== "undefined") {
  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
    if (type === "2d") {
      return {
        font: "",
        measureText: (t: string) => ({ width: t.length }),
        fillText: () => {},
        clearRect: () => {},
        fillRect: () => {},
        getImageData: (_x: number, _y: number, w: number, h: number) => ({
          data: new Uint8ClampedArray(Math.max(1, w * h * 4)),
          width: w,
          height: h,
        }),
        putImageData: () => {},
        drawImage: () => {},
        createTexture: () => null,
      } as unknown as CanvasRenderingContext2D;
    }
    return origGetContext.call(this, type as never, ...(rest as never[]));
  } as typeof HTMLCanvasElement.prototype.getContext;
}
