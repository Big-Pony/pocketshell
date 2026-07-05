// app/src/lib/terminal-select.ts
// Pure selection state machine for keyboard-driven text selection in the
// read-only terminal. Anchor is snapshotted at the terminal cursor when
// selection begins; arrow keys move the focus. range() yields xterm
// select(col,row,length) args, normalizing forward and reverse selections.
// Coordinates are ABSOLUTE buffer rows (0 = top of scrollback), matching
// xterm's term.select() / buffer.getLine() coordinate system.

export type SelDir = "up" | "down" | "left" | "right";
export interface Pos { row: number; col: number }
export type SelMode = "idle" | "selecting";
export interface SelState { mode: SelMode; anchor: Pos; focus: Pos }
export interface SelBounds { cols: number; maxRow: number }
export interface SelRange { col: number; row: number; length: number }

export const IDLE: SelState = {
  mode: "idle",
  anchor: { row: 0, col: 0 },
  focus: { row: 0, col: 0 },
};

export function begin(cursor: Pos): SelState {
  return { mode: "selecting", anchor: { ...cursor }, focus: { ...cursor } };
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export function moveFocus(s: SelState, dir: SelDir, b: SelBounds): SelState {
  if (s.mode !== "selecting") return s;
  let { row, col } = s.focus;
  if (dir === "up") row -= 1;
  else if (dir === "down") row += 1;
  else if (dir === "left") col -= 1;
  else col += 1;
  return { ...s, focus: { row: clamp(row, 0, b.maxRow), col: clamp(col, 0, b.cols - 1) } };
}

// Total order over positions: earlier row first, then earlier col.
function beforeOrEqual(a: Pos, p: Pos): boolean {
  return a.row < p.row || (a.row === p.row && a.col <= p.col);
}

export function range(s: SelState, cols: number): SelRange {
  const [start, end] = beforeOrEqual(s.anchor, s.focus)
    ? [s.anchor, s.focus]
    : [s.focus, s.anchor];
  const length = (end.row - start.row) * cols + (end.col - start.col) + 1;
  return { col: start.col, row: start.row, length };
}

export function reset(): SelState {
  return IDLE;
}
