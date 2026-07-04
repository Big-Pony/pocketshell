// P1: file service. Stateless — takes absolute-ish paths, resolves them, and
// reads the real filesystem. NO sandbox: the trust boundary is the Noise
// handshake + pairing (an authorized device is the operator), so access is
// bounded only by the agent process's own permissions.
import { readdirSync, statSync, readFileSync } from "node:fs";
import { resolve, join, extname } from "node:path";

export interface TreeNode {
  name: string;
  type: "dir" | "file";
  git?: "M" | "A" | "D" | "?";
  hasChildren?: boolean;
}
export interface TreeResult { path: string; nodes: TreeNode[]; truncated?: boolean }

const DEFAULT_MAX_NODES = 500;

// Non-empty probe: read at most a couple entries; don't full-readdir children.
function dirHasChildren(dir: string): boolean {
  try {
    const it = readdirSync(dir);
    return it.length > 0;
  } catch {
    return false; // unreadable dir → treat as leaf
  }
}

export function fsTree(path: string, opts: { maxNodes?: number } = {}): TreeResult {
  const abs = resolve(path);
  const st = statSync(abs); // throws ENOENT → caller wraps as error response
  if (!st.isDirectory()) throw new Error(`enotdir: ${abs} is not a directory`);
  const max = opts.maxNodes ?? DEFAULT_MAX_NODES;

  const raw = readdirSync(abs, { withFileTypes: true });
  const dirs: TreeNode[] = [];
  const files: TreeNode[] = [];
  for (const e of raw) {
    if (e.isDirectory()) dirs.push({ name: e.name, type: "dir", hasChildren: dirHasChildren(join(abs, e.name)) });
    else files.push({ name: e.name, type: "file" });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  const all = [...dirs, ...files];
  const truncated = all.length > max;
  return { path: abs, nodes: truncated ? all.slice(0, max) : all, ...(truncated ? { truncated: true } : {}) };
}

export interface ReadResult { path: string; content: string; lang: string; truncated?: boolean; binary?: boolean }

const LANG_BY_EXT: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".mjs": "javascript",
  ".cjs": "javascript", ".jsx": "javascript", ".json": "json", ".md": "markdown",
  ".css": "css", ".html": "xml", ".svelte": "xml", ".sh": "bash", ".bash": "bash",
  ".py": "python", ".go": "go", ".rs": "rust", ".yml": "yaml", ".yaml": "yaml", ".toml": "ini",
};

export function langForExt(name: string): string {
  return LANG_BY_EXT[extname(name).toLowerCase()] ?? "plaintext";
}

const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_MAX_LINES = 5000;

export function fsRead(path: string, opts: { maxBytes?: number; maxLines?: number } = {}): ReadResult {
  const abs = resolve(path);
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;
  const buf = readFileSync(abs); // throws ENOENT → caller wraps
  const lang = langForExt(abs);

  // Binary sniff: a NUL byte in the first chunk means "not text".
  const sniff = buf.subarray(0, Math.min(buf.length, 8192));
  if (sniff.includes(0)) return { path: abs, content: "", lang, binary: true };

  let truncated = false;
  let slice = buf;
  if (buf.length > maxBytes) { slice = buf.subarray(0, maxBytes); truncated = true; }
  let text = slice.toString("utf8");
  const lines = text.split("\n");
  if (lines.length > maxLines) { text = lines.slice(0, maxLines).join("\n"); truncated = true; }
  return { path: abs, content: text, lang, ...(truncated ? { truncated: true } : {}) };
}
