// "Copy last output" without guessing at prompts.
//
// The old approach (lib/terminal-output.ts, still the fallback) scanned upward
// from the cursor for a line matching a shell-prompt regex. That is a guess: a
// themed prompt, a prompt that is not at column 0, or output that merely LOOKS
// like a prompt all mis-slice the copy.
//
// The frontend already knows something better. Every byte the user sends goes
// through Connection.sendInput, so at the instant an input containing Return
// goes out we can record where the cursor is in xterm's buffer — that row is
// exactly where the command's output is about to begin. No parsing, no regex.
//
// The recorded row is then turned into a DISTANCE ABOVE THE CURSOR and sent to
// the agent, which resolves it against tmux's own cursor (see rowsBack for why a
// distance and not an absolute row). The text therefore comes from tmux —
// complete and unwrapped — rather than from xterm's bounded, width-wrapped
// buffer.

// A byte sequence "submits a command" if it contains CR (Return) or LF. The
// custom keyboard sends \r for Return; a pasted multi-line block carries \n.
// Anything else (plain characters, arrow keys, Ctrl-C) leaves the anchor alone.
export function containsSubmit(data: Uint8Array): boolean {
  for (const b of data) if (b === 0x0d || b === 0x0a) return true;
  return false;
}

// The parts of xterm's active buffer this module reads.
export interface AnchorBuffer {
  baseY: number; // rows of scrollback above the viewport
  cursorY: number; // cursor row within the viewport
}

// Absolute row in xterm's buffer where the current command's output starts:
// the row the cursor sits on when Return goes out. +1 would skip the command
// line itself, but the command line is worth keeping in the copy (it is what
// the output is output OF) — and more importantly tmux's row grid and xterm's
// do not line up exactly (wrapped lines are unwrapped by `-J`), so a tight
// off-by-one here would be false precision.
export function anchorRow(buf: AnchorBuffer): number {
  return buf.baseY + buf.cursorY;
}

// How many rows above the CURRENT cursor the anchor sits — the value sent to the
// backend as `back`, which resolves it against tmux's own `#{cursor_y}`.
//
// Why a distance rather than the absolute row: xterm and tmux do not share a row
// origin. xterm's rows count from the top of ITS scrollback; tmux's `-S 0` is the
// top of the visible pane, and after a history seed the two disagree outright —
// measured on one live pane, xterm reported cursorY=23 while tmux reported
// cursor_y=3, because tmux pads the pane with blank rows that the seeded byte
// stream never reproduces as cursor movement. Sending an absolute row silently
// copied the wrong slice. The distance from the cursor is immune to that skew,
// because both ends measure it from the same place: the cursor.
//
// Clamped at 0: a negative distance would mean the anchor is BELOW the cursor,
// which only happens if the buffer was cleared/reset under us. 0 then copies
// just the current line rather than something arbitrary.
export function rowsBack(anchor: number, cursorAbs: number): number {
  return Math.max(0, cursorAbs - anchor);
}

// tmux's capture always ends at the bottom of the visible screen, so an anchored
// capture still carries the trailing prompt line the shell drew AFTER the output
// finished. Drop that one trailing prompt-ish line, plus blank padding, so the
// clipboard holds the output and not the cursor's leftovers.
//
// Conservative on purpose: only the LAST line is ever dropped, and only when it
// looks like a bare prompt (a prompt sigil with nothing but whitespace after it,
// or an empty line). A prompt line with a command typed after it is real content
// — that is the command being copied — and is kept.
export function trimTrailingPrompt(text: string, promptRe: RegExp): string {
  const lines = text.split("\n");
  // Drop trailing blank lines FIRST, but keep each surviving line intact: the
  // prompt test needs the whitespace that follows the sigil ("$ " matches,
  // a right-trimmed "$" would not).
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  const last = lines[lines.length - 1] ?? "";
  if (lines.length > 1 && promptRe.test(last) && last.replace(promptRe, "").trim() === "") {
    lines.pop();
  }
  return lines.join("\n").replace(/\s+$/, "");
}

// Per-session anchor bookkeeping. Deliberately a plain map with no eviction
// beyond explicit clear(): one small integer per session, and a session's
// anchor must survive tab switches (the whole point is to remember a command
// the user ran a while ago).
export class OutputAnchors {
  private rows = new Map<string, number>();

  // Record the anchor for `session` if this input submits a command.
  // Returns whether an anchor was recorded, for tests and diagnostics.
  record(session: string, data: Uint8Array, buf: AnchorBuffer | undefined): boolean {
    if (!buf || !containsSubmit(data)) return false;
    this.rows.set(session, anchorRow(buf));
    return true;
  }

  get(session: string): number | undefined {
    return this.rows.get(session);
  }

  clear(session: string): void {
    this.rows.delete(session);
  }
}
