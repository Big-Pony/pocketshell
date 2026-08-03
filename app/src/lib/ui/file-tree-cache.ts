// Module-level singleton so FileTree's browse state survives the component being
// destroyed when the user switches bottom panels or toggles fullscreen. Plain
// module state (not runes) so it's trivially unit-testable and outlives every
// component mount. Holds the fetched/expanded tree so remount needs no fs.tree.
import { loadProjectRoot, type FileNode } from "./file-tree";

export interface BrowseCache {
  root: string;
  nodes: FileNode[];
  query: string;
  scrollTop: number;
  loaded: boolean; // true once the first fs.tree load populated `nodes`
}

function fresh(): BrowseCache {
  return { root: loadProjectRoot(), nodes: [], query: "", scrollTop: 0, loaded: false };
}

let cache: BrowseCache = fresh();

export function getBrowseCache(): BrowseCache { return cache; }
export function setBrowseCache(patch: Partial<BrowseCache>): void { cache = { ...cache, ...patch }; }
export function resetBrowseCache(): void { cache = fresh(); }
