// Pure decision for the page-fullscreen toggle. DOM side effects live in the
// component; this module only decides which action the current document supports.
// iOS Safari lacks Element.requestFullscreen entirely -> "unsupported".
export type FsAction = "enter" | "exit" | "unsupported";

export function fullscreenAction(doc: Document): FsAction {
  const el = doc.documentElement as unknown as { requestFullscreen?: unknown };
  const canEnter = typeof el.requestFullscreen === "function";
  const canExit = typeof (doc as unknown as { exitFullscreen?: unknown }).exitFullscreen === "function";
  if (!canEnter || !canExit) return "unsupported";
  return doc.fullscreenElement ? "exit" : "enter";
}
