// Core notification dispatch logic. decideDispatch is pure so the dedupe window
// and presence-based "smart do-not-disturb" rules are unit-testable without any
// network. A device that is foregrounded AND looking at the very session that
// finished does NOT get a system push (it already sees the in-app hint).
export interface DevicePresence { pubKey: string; foreground: boolean; activeSessionId: string | null; }
export interface DispatchDecision { inApp: boolean; pushPubKeys: string[]; webhook: boolean; }

export function decideDispatch(args: {
  sessionId: string; lastTs: number | undefined; now: number; dedupeMs: number;
  presences: DevicePresence[];
}): DispatchDecision | null {
  if (args.lastTs !== undefined && args.now - args.lastTs < args.dedupeMs) return null;
  const pushPubKeys = args.presences
    .filter((p) => !(p.foreground && p.activeSessionId === args.sessionId))
    .map((p) => p.pubKey);
  return { inApp: true, pushPubKeys, webhook: true };
}
