// P2: file transfer orchestration (pure-ish; DOM download helper lives in the
// download half). All bytes travel the encrypted WS via conn.rpc — chunked
// base64 to stay well under the WS payload cap.
import { toB64, fromB64 } from "./bytes";

export const MAX_TRANSFER_BYTES = 200 * 1024 * 1024;

// Chunk size is bounded by the Noise transport: SecureChannel encrypts each RPC
// as ONE ChaChaPoly message, and noise-handshake hard-caps ciphertext at 65535
// bytes (plaintext ≤ 65519). A chunk travels as base64 in dataB64 (×4/3) inside
// a small JSON envelope, so the raw chunk must stay well under ~48KB. 45KB keeps
// base64 (~61.4KB) + envelope + 16B MAC comfortably below the cap. Do NOT raise
// this without adding transport-level framing (see spec non-goals).
export const CHUNK_BYTES = 45 * 1024;

export type RpcLike = { rpc(method: string, params?: unknown): Promise<unknown> };
export type UploadItem = { name: string; size: number; blob: Blob; destName: string };

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function chunkOffsets(size: number, chunk: number): [number, number][] {
  if (size === 0) return [[0, 0]];
  const out: [number, number][] = [];
  for (let o = 0; o < size; o += chunk) out.push([o, Math.min(chunk, size - o)]);
  return out;
}

export function childPath(dir: string, name: string): string {
  return dir === "/" ? "/" + name : dir + "/" + name;
}

function uploadId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function uploadFiles(
  conn: RpcLike, dir: string, items: UploadItem[],
  opts: { chunkBytes?: number; onProgress?: (uploaded: number, total: number) => void; shouldCancel?: () => boolean } = {},
): Promise<void> {
  const chunk = opts.chunkBytes ?? CHUNK_BYTES;
  const total = items.reduce((s, it) => s + it.size, 0);
  let uploaded = 0;
  for (const it of items) {
    const id = uploadId();
    const destPath = childPath(dir, it.destName);
    const windows = chunkOffsets(it.size, chunk);
    for (let i = 0; i < windows.length; i++) {
      if (opts.shouldCancel?.()) return;
      const [off, len] = windows[i];
      const bytes = new Uint8Array(await it.blob.slice(off, off + len).arrayBuffer());
      const first = i === 0;
      const last = i === windows.length - 1;
      await conn.rpc("fs.uploadChunk", { uploadId: id, dataB64: toB64(bytes), first, last, ...(last ? { destPath } : {}) });
      uploaded += len;
      opts.onProgress?.(uploaded, total);
    }
  }
}

export function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return (i < 0 ? path : path.slice(i + 1)) || "root";
}

export async function downloadFileBlob(
  conn: RpcLike, path: string, opts: { chunkBytes?: number } = {},
): Promise<Blob> {
  const chunk = opts.chunkBytes ?? CHUNK_BYTES;
  // Pre-check size so the user gets a localized error before any real bytes flow.
  const probe = (await conn.rpc("fs.downloadChunk", { path, offset: 0, len: 0 })) as { dataB64: string; eof: boolean; size: number };
  if (probe.size > MAX_TRANSFER_BYTES) throw new Error("文件超过 200MB 上限");
  if (probe.eof) return new Blob([]);
  const parts: BlobPart[] = [];
  let offset = 0;
  for (;;) {
    const r = (await conn.rpc("fs.downloadChunk", { path, offset, len: chunk })) as { dataB64: string; eof: boolean; size: number };
    const bytes = fromB64(r.dataB64);
    if (bytes.length > 0) { parts.push(bytes); offset += bytes.length; }
    if (r.eof || bytes.length === 0) break;
  }
  return new Blob(parts);
}

export function triggerBrowserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

export async function downloadFolder(
  conn: RpcLike, path: string, opts: { onArchiving?: (busy: boolean) => void } = {},
): Promise<void> {
  opts.onArchiving?.(true);
  let archivePath: string;
  try {
    const r = (await conn.rpc("fs.archive", { path })) as { archivePath: string; size: number };
    archivePath = r.archivePath;
  } finally { opts.onArchiving?.(false); }
  const blob = await downloadFileBlob(conn, archivePath);
  triggerBrowserDownload(blob, baseName(path) + ".zip");
  try { await conn.rpc("fs.op", { op: "delete", path: archivePath }); } catch { /* best-effort cleanup */ }
}
