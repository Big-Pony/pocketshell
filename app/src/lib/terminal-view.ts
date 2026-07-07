// Pure view-mode helpers for the terminal. Two display modes keyed off the
// xterm buffer type:
//  - "normal" shell buffer: rows == visible rows; history lives in xterm's
//    scrollback and xterm's own viewport scrolls it (native).
//  - "alternate" buffer (full-screen apps like Claude): give the pane 3x the
//    visible rows so the app draws content that overflows the viewport, then
//    let an outer container scroll to reveal it (container).
export type BufferType = "normal" | "alternate";
export type ScrollMode = "native" | "container";

export const VIRTUAL_ROW_FACTOR = 3;

/** Rows to request for the PTY/xterm given the visible rows and buffer type. */
export function virtualRows(visRows: number, buffer: BufferType): number {
  const v = Math.max(1, Math.floor(visRows));
  return buffer === "alternate" ? v * VIRTUAL_ROW_FACTOR : v;
}

/** Which scrolling strategy the frontend should use for a buffer type. */
export function scrollMode(buffer: BufferType): ScrollMode {
  return buffer === "alternate" ? "container" : "native";
}
