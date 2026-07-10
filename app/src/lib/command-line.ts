// Input-side reconstruction of the user's current shell command line, driven by
// the bytes we send to the PTY (xterm is read-only; sendActive is the single
// outbound path). It cannot see PTY echo, so cursor-movement / Tab-completion /
// multi-line editing mark the line "untrusted" → callers should stop hinting.
export interface CmdLineState {
  line: string;
  trusted: boolean;
  history: string[];
}

const HISTORY_MAX = 200;

export function emptyCmdLine(): CmdLineState {
  return { line: "", trusted: true, history: [] };
}

function commit(history: string[], cmd: string): string[] {
  return [cmd, ...history.filter((h) => h !== cmd)].slice(0, HISTORY_MAX);
}

function dropLast(line: string): string {
  const a = Array.from(line); // codepoint-safe backspace (CJK/emoji)
  a.pop();
  return a.join("");
}

export function feed(s: CmdLineState, text: string): CmdLineState {
  let { line, trusted, history } = s;
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const code = c.codePointAt(0)!;
    if (c === "\r" || c === "\n") {
      // Only commit when the reconstruction is still trustworthy. An untrusted
      // line (after cursor movement / Tab completion / multi-line editing) is a
      // guess that would pollute history and later completions, so drop it.
      const cmd = line.trim();
      if (cmd && trusted) history = commit(history, cmd);
      line = "";
      trusted = true;
    } else if (code === 0x7f || code === 0x08) {
      line = dropLast(line);
    } else if (code === 0x03 || code === 0x15) {
      // Ctrl-C / Ctrl-U
      line = "";
      trusted = true;
    } else if (code === 0x1b) {
      // ESC
      if (i + 1 < chars.length) {
        // escape sequence or Alt combo: we cannot model the result
        trusted = false;
        break;
      }
      line = "";
      trusted = true;
    } else if (code === 0x09) {
      // Tab
      trusted = false;
    } else if (code < 0x20) {
      // other control chars we cannot model
      trusted = false;
    } else {
      line += c;
    }
  }
  return { line, trusted, history };
}
