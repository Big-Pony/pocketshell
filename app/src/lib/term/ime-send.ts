// Bytes the IME buffer's "send to terminal" produces. Empty buffer = a bare
// Enter (\r) so users don't have to switch to the full keyboard just to press
// Return (req 7-6); non-empty = the composed text followed by Enter.
export function imeSendText(buf: string): string {
  return buf ? buf + "\r" : "\r";
}
