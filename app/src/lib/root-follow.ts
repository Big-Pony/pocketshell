// Pure decision for 需求9: tapping the bottom "文件" panel while a terminal tab
// is focused (and root-follow is on) should re-point the project root at the
// terminal's real pwd. Returns the pwd to sync to, or null for a no-op.
export interface RootFollowInput {
  panel: string;        // the bottom panel being opened
  follow: boolean;      // loadRootFollow()
  activeTopId: string;  // focused top tab id
  pwd: string;          // terminal.pwd result ("" when unavailable / shell)
  currentRoot: string;  // loadProjectRoot()
}

export function shouldSyncRoot(i: RootFollowInput): string | null {
  if (i.panel !== "file") return null;
  if (!i.follow) return null;
  if (!i.activeTopId || i.activeTopId.startsWith("file:")) return null; // not a terminal
  if (!i.pwd) return null;                  // shell / no pwd → leave root as-is
  if (i.pwd === i.currentRoot) return null; // already in sync
  return i.pwd;
}
