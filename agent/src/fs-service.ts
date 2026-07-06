// P1: file service. Stateless — takes absolute-ish paths, resolves them, and
// reads the real filesystem. NO sandbox: the trust boundary is the Noise
// handshake + pairing (an authorized device is the operator), so access is
// bounded only by the agent process's own permissions.
import { readdirSync, statSync, readFileSync, renameSync, unlinkSync, rmSync, mkdirSync, existsSync, appendFileSync, copyFileSync, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import { resolve, join, extname, dirname, basename } from "node:path";
import { runGit, isRepo } from "./git-service";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

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

function markFromXY(xy: string, prev?: "M" | "A" | "D" | "?"): "M" | "A" | "D" | "?" {
  if (xy === "??") return "?";
  for (const ch of xy) { if (ch === "M") return "M"; if (ch === "A") return "A"; if (ch === "D") return "D"; }
  return prev ?? "?";
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

  // Inline git marks for this level only (path-following; independent of the
  // project-root bookmark). Non-repo dirs stay unmarked.
  if (isRepo(abs)) {
    const stGit = runGit(abs, ["status", "--porcelain", "."]);
    const marks = new Map<string, "M" | "A" | "D" | "?">();
    for (const line of stGit.stdout.split("\n")) {
      if (!line) continue;
      const rel = line.slice(3);
      // Only mark direct children of this level; nested paths (a/b) belong to sub-levels.
      const name = rel.split("/")[0];
      if (name) marks.set(name, markFromXY(line.slice(0, 2), marks.get(name)));
    }
    for (const n of all) { const m = marks.get(n.name); if (m) n.git = m; }
  }

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

export interface DiffHunk { header: string; lines: { kind: "add" | "del" | "ctx"; text: string }[] }

export function fsDiff(path: string, cwd?: string): { path: string; hunks: DiffHunk[] } {
  const abs = resolve(path);
  if (!cwd || cwd === "undefined") cwd = dirname(abs);
  const r = runGit(cwd, ["diff", "--", abs]);
  const hunks: DiffHunk[] = [];
  let cur: DiffHunk | null = null;
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("@@")) { cur = { header: line, lines: [] }; hunks.push(cur); continue; }
    if (!cur) continue; // skip file header lines before first hunk
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) cur.lines.push({ kind: "add", text: line.slice(1) });
    else if (line.startsWith("-")) cur.lines.push({ kind: "del", text: line.slice(1) });
    else cur.lines.push({ kind: "ctx", text: line.startsWith(" ") ? line.slice(1) : line });
  }
  return { path: abs, hunks };
}

export const MAX_TRANSFER_BYTES = 200 * 1024 * 1024;

export function fsUploadCheck(dir: string, names: string[]): { conflicts: string[] } {
  const abs = resolve(dir);
  return { conflicts: names.filter((n) => existsSync(join(abs, n))) };
}

export function fsResolveName(dir: string, name: string): { name: string } {
  const abs = resolve(dir);
  if (!existsSync(join(abs, name))) return { name };
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 1; ; i++) {
    const candidate = `${base}(${i})${ext}`;
    if (!existsSync(join(abs, candidate))) return { name: candidate };
  }
}

export function fsUploadChunk(
  tmpDir: string, uploadId: string, dataB64: string,
  opts: { first?: boolean; last?: boolean; destPath?: string } = {}
): { written: number } {
  const part = join(resolve(tmpDir), `psupload-${uploadId}.part`);
  const buf = Buffer.from(dataB64, "base64");
  if (opts.first) writeFileSync(part, buf);
  else appendFileSync(part, buf);
  const written = statSync(part).size;
  if (written > MAX_TRANSFER_BYTES) {
    try { unlinkSync(part); } catch {}
    throw new Error(`upload exceeds ${MAX_TRANSFER_BYTES} bytes`);
  }
  if (opts.last) {
    if (!opts.destPath) throw new Error("last chunk requires destPath");
    copyFileSync(part, resolve(opts.destPath)); // local copy = network-断线-safe landing
    unlinkSync(part);
  }
  return { written };
}

export function fsDownloadChunk(path: string, offset: number, len: number): { dataB64: string; eof: boolean; size: number } {
  const abs = resolve(path);
  const size = statSync(abs).size;
  if (size > MAX_TRANSFER_BYTES) throw new Error(`file exceeds ${MAX_TRANSFER_BYTES} bytes`);
  const end = Math.min(offset + len, size);
  const length = Math.max(0, end - offset);
  const buf = Buffer.alloc(length);
  if (length > 0) {
    const fd = openSync(abs, "r");
    try { readSync(fd, buf, 0, length, offset); } finally { closeSync(fd); }
  }
  return { dataB64: buf.toString("base64"), eof: end >= size, size };
}

export function fsArchive(tmpDir: string, path: string): { archivePath: string; size: number } {
  const abs = resolve(path);
  if (!statSync(abs).isDirectory()) throw new Error(`not a directory: ${abs}`);
  const archivePath = join(resolve(tmpDir), `psarchive-${randomBytes(6).toString("hex")}.zip`);
  // -r recurse, -q quiet; cwd = parent so the archive stores a single top folder.
  const r = spawnSync("zip", ["-r", "-q", archivePath, basename(abs)], { cwd: dirname(abs) });
  if (r.error) throw new Error(`zip unavailable: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`zip exited ${r.status}: ${r.stderr?.toString() ?? ""}`);
  const size = statSync(archivePath).size;
  if (size > MAX_TRANSFER_BYTES) {
    try { unlinkSync(archivePath); } catch {}
    throw new Error(`archive exceeds ${MAX_TRANSFER_BYTES} bytes`);
  }
  return { archivePath, size };
}

export function fsOp(op: "rename" | "delete" | "mkdir", path: string, to?: string): { ok: true } {
  const abs = resolve(path);
  if (op === "rename") {
    if (!to) throw new Error("rename requires a target");
    statSync(abs); // recheck source exists
    renameSync(abs, resolve(to));
    return { ok: true };
  }
  if (op === "delete") {
    const st = statSync(abs); // recheck exists
    if (st.isDirectory()) rmSync(abs, { recursive: true });
    else unlinkSync(abs);
    return { ok: true };
  }
  if (op === "mkdir") {
    statSync(dirname(abs)); // parent must exist (throws otherwise) — no recursive
    mkdirSync(abs);
    return { ok: true };
  }
  throw new Error(`unknown op: ${op}`);
}
