// P1 project-root bookmark + immutable tree ops. No DOM beyond localStorage.
const ROOT_KEY = "pocketshell.projectRoot";
const ROOT_HISTORY_KEY = "pocketshell.projectRootHistory";
const ROOT_FOLLOW_KEY = "pocketshell.rootFollow";
const ROOT_HISTORY_MAX = 10;

export interface FileNode {
  name: string; path: string; type: "dir" | "file";
  git?: "M" | "A" | "D" | "?"; hasChildren?: boolean;
  expanded?: boolean; children?: FileNode[];
}

export function loadProjectRoot(): string {
  try { return localStorage.getItem(ROOT_KEY) || "/"; } catch { return "/"; }
}
export function saveProjectRoot(path: string): void {
  try { localStorage.setItem(ROOT_KEY, path); } catch {}
}
export function clearProjectRoot(): void {
  try { localStorage.removeItem(ROOT_KEY); } catch {}
}

export function loadRootHistory(): string[] {
  try {
    const arr = JSON.parse(localStorage.getItem(ROOT_HISTORY_KEY) || "[]");
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}
export function pushRootHistory(path: string): void {
  try {
    const next = [path, ...loadRootHistory().filter((p) => p !== path)].slice(0, ROOT_HISTORY_MAX);
    localStorage.setItem(ROOT_HISTORY_KEY, JSON.stringify(next));
  } catch {}
}

export function loadRootFollow(store: Storage = localStorage): boolean {
  return store.getItem(ROOT_FOLLOW_KEY) === "1";
}

export function saveRootFollow(on: boolean, store: Storage = localStorage): void {
  store.setItem(ROOT_FOLLOW_KEY, on ? "1" : "0");
}

function joinPath(parent: string, name: string): string {
  return parent === "/" ? "/" + name : parent + "/" + name;
}

type Raw = { name: string; type: "dir" | "file"; git?: "M" | "A" | "D" | "?"; hasChildren?: boolean };
export function toFileNodes(parentPath: string, nodes: Raw[]): FileNode[] {
  return nodes.map((n) => ({ ...n, path: joinPath(parentPath, n.name) }));
}

export function setChildren(root: FileNode[], path: string, children: FileNode[]): FileNode[] {
  return root.map((n) => {
    if (n.path === path) return { ...n, children, expanded: true };
    if (n.children) return { ...n, children: setChildren(n.children, path, children) };
    return n;
  });
}

export function collapse(root: FileNode[], path: string): FileNode[] {
  return root.map((n) => {
    if (n.path === path) return { ...n, expanded: false };
    if (n.children) return { ...n, children: collapse(n.children, path) };
    return n;
  });
}

export function filterTree(root: FileNode[], query: string): FileNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return root;
  const walk = (nodes: FileNode[]): FileNode[] => {
    const out: FileNode[] = [];
    for (const n of nodes) {
      const selfHit = n.name.toLowerCase().includes(q);
      const kids = n.children ? walk(n.children) : [];
      if (selfHit || kids.length) out.push({ ...n, children: kids.length ? kids : n.children, expanded: kids.length ? true : n.expanded });
    }
    return out;
  };
  return walk(root);
}

// Depth-first collect of every currently-expanded directory path, so a refresh
// can re-fetch those levels and restore the same expansion afterwards.
export function collectExpandedPaths(nodes: FileNode[]): Set<string> {
  const out = new Set<string>();
  const walk = (list: FileNode[]) => {
    for (const n of list) {
      if (n.type === "dir" && n.expanded) out.add(n.path);
      if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}
