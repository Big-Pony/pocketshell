// "Copy last output" for the keyboard's quick-action panel. Extract the text
// produced by the most recent command: scan up from the cursor for the nearest
// shell prompt line, take everything after it. If the current prompt is an empty
// waiting prompt, walk up to the previous command. With no prompt at all (Claude
// Code's full-screen TUI has none) fall back to the visible viewport.
// Anchored to line start: real shell prompts sit at column 0 (after trim), so
// output like "building 50% done" or "$ x" mid-line isn't mis-read as a boundary.
export const PROMPT_RE = /^[❯➜$#%]\s/;

export interface BufferLike {
  length: number;
  baseY: number;
  cursorY: number;
  viewportY: number;
  getLine(i: number): { translateToString(trim: boolean): string } | undefined;
}

function lineAt(buf: BufferLike, i: number): string {
  return buf.getLine(i)?.translateToString(true) ?? "";
}

function joinCollapsed(parts: string[]): string {
  return parts.join("\n").replace(/\n+$/, "");
}

export function lastOutput(buf: BufferLike, rows: number, promptRe: RegExp = PROMPT_RE): string {
  const bottom = buf.baseY + buf.cursorY;

  // nearest prompt at or above the cursor = the current/last command line.
  let cmd = -1;
  for (let i = bottom; i >= 0; i--) {
    if (promptRe.test(lineAt(buf, i))) { cmd = i; break; }
  }

  if (cmd === -1) {
    // No prompt anywhere → full-screen TUI. Copy the visible viewport.
    const top = Math.max(0, buf.viewportY);
    const end = Math.min(buf.length - 1, top + rows - 1);
    const out: string[] = [];
    for (let i = top; i <= end; i++) out.push(lineAt(buf, i));
    return joinCollapsed(out);
  }

  // Output = lines after the command line, down to the bottom.
  const collect = (from: number, to: number): string[] => {
    const out: string[] = [];
    for (let i = from; i <= to; i++) out.push(lineAt(buf, i));
    return out;
  };
  let out = collect(cmd + 1, bottom);

  // If that's empty (cursor on a fresh waiting prompt), use the previous command.
  if (joinCollapsed(out) === "") {
    let prev = -1;
    for (let i = cmd - 1; i >= 0; i--) {
      if (promptRe.test(lineAt(buf, i))) { prev = i; break; }
    }
    if (prev !== -1) out = collect(prev + 1, cmd - 1);
  }

  return joinCollapsed(out);
}
