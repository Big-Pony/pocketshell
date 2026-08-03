// P2: file transfer orchestration (pure-ish; DOM download helper lives in the
// download half). All bytes travel the encrypted WS via conn.rpc — chunked
// base64 to stay well under the WS payload cap.
import { toB64, fromB64 } from "./bytes";
import { tr } from "./i18n";

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
  opts: { chunkBytes?: number; windowSize?: number; onProgress?: (uploaded: number, total: number) => void; shouldCancel?: () => boolean } = {},
): Promise<void> {
  const chunk = opts.chunkBytes ?? CHUNK_BYTES;
  const total = items.reduce((s, it) => s + it.size, 0);
  let uploaded = 0;
  for (const it of items) {
    const id = uploadId();
    const destPath = childPath(dir, it.destName);
    const r = await uploadChunksWindowed(conn, id, it.blob, chunkOffsets(it.size, chunk), destPath, {
      windowSize: opts.windowSize,
      shouldCancel: opts.shouldCancel,
      onChunkDone: (n) => { uploaded += n; opts.onProgress?.(uploaded, total); },
    });
    if (r === "cancelled") return;
  }
}

// WP-5: upload concurrency, mirroring the download window (A8 below) — but
// with one extra hard constraint: fs.uploadChunk carries no offset, the server
// appends frames in ARRIVAL order, and the WS connection delivers in SEND
// order, so chunk rpcs must be issued strictly in index order. Blob slicing is
// async (a disk-backed File may complete reads out of order), so reads are
// pumped ahead of the send cursor into `slots` while a single send loop does
// every conn.rpc call itself — wire order therefore always matches index
// order, no matter how reads or rpcs interleave. Up to `windowSize` rpcs are
// in flight at once; any chunk failure stops new sends and rejects the whole
// upload (the half-written temp file is swept server-side, as before).
export const UPLOAD_WINDOW = 4;

export async function uploadChunksWindowed(
  conn: RpcLike, uploadId: string, blob: Blob, windows: [number, number][], destPath: string,
  opts: { windowSize?: number; shouldCancel?: () => boolean; onChunkDone?: (bytes: number) => void } = {},
): Promise<"done" | "cancelled"> {
  const n = windows.length;
  if (n === 0) return "done";
  const windowSize = Math.max(1, opts.windowSize ?? UPLOAD_WINDOW);

  // Read pump: at most `windowSize` slice reads outstanding, so memory stays
  // bounded at ~2 windows of chunks instead of the whole file.
  const slots: (Promise<Uint8Array> | undefined)[] = new Array(n);
  let readNext = 0;
  const pumpReads = (upto: number) => {
    while (readNext < Math.min(upto, n)) {
      const i = readNext++;
      const [off, len] = windows[i];
      slots[i] = blob.slice(off, off + len).arrayBuffer().then((ab) => new Uint8Array(ab));
    }
  };

  let firstError: unknown = null;
  let cancelled = false;
  const inflight = new Set<Promise<void>>();
  // Tracked rpc promises never reject (errors land in firstError), so
  // Promise.race/all over `inflight` never throws and nothing is unhandled.
  const track = (p: Promise<unknown>, len: number) => {
    const t = p.then(
      () => { inflight.delete(t); opts.onChunkDone?.(len); },
      (e) => { inflight.delete(t); if (firstError === null) firstError = e; },
    );
    inflight.add(t);
  };

  // Windowed phase: every chunk except the final one.
  let i = 0;
  while (i < n - 1) {
    if (firstError !== null) break;
    if (opts.shouldCancel?.()) { cancelled = true; break; } // checked at each window boundary
    if (inflight.size >= windowSize) { await Promise.race(inflight); continue; }
    pumpReads(i + windowSize);
    try {
      const bytes = await slots[i]!;
      slots[i] = undefined; // free the slice as soon as it is on the wire
      track(conn.rpc("fs.uploadChunk", { uploadId, dataB64: toB64(bytes), first: i === 0, last: false }), windows[i][1]);
      i++;
    } catch (e) { firstError = e; break; }
  }

  // Closing barrier: the `last` chunk carries destPath and must be the last
  // frame out — only sent once every other chunk's rpc has fully settled, so
  // the server has all data appended before it commits the temp file.
  await Promise.all([...inflight]);
  if (firstError === null && !cancelled && opts.shouldCancel?.()) cancelled = true;
  if (firstError === null && !cancelled) {
    pumpReads(n);
    try {
      const bytes = await slots[n - 1]!;
      await conn.rpc("fs.uploadChunk", { uploadId, dataB64: toB64(bytes), first: n === 1, last: true, destPath });
      opts.onChunkDone?.(windows[n - 1][1]);
    } catch (e) { firstError = e; }
  }
  if (firstError !== null) throw firstError;
  return cancelled ? "cancelled" : "done";
}

export function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return (i < 0 ? path : path.slice(i + 1)) || "root";
}

export async function downloadFileBlob(
  conn: RpcLike, path: string,
  opts: { chunkBytes?: number; windowSize?: number; onProgress?: (downloaded: number, total: number) => void } = {},
): Promise<Blob> {
  const chunk = opts.chunkBytes ?? CHUNK_BYTES;
  // Pre-check size so the user gets a localized error before any real bytes flow.
  const probe = (await conn.rpc("fs.downloadChunk", { path, offset: 0, len: 0 })) as { dataB64: string; eof: boolean; size: number };
  if (probe.size > MAX_TRANSFER_BYTES) throw new Error(tr("errors.transfer.tooBig"));
  if (probe.eof) return new Blob([]);
  let downloaded = 0;
  const parts = await fetchChunksWindowed(conn, path, chunkOffsets(probe.size, chunk), opts.windowSize, (n) => {
    downloaded += n;
    opts.onProgress?.(downloaded, probe.size);
  });
  return new Blob(parts as BlobPart[]);
}

// A8: download concurrency. Chunks used to be fetched strictly serially, so on
// high-RTT links throughput was locked to CHUNK_BYTES/RTT. Workers pull window
// indices off a shared cursor (each index is taken synchronously before any
// await, so no two workers fetch the same window); results land in `parts[i]`
// and are thus re-assembled in OFFSET order even when RPCs resolve out of
// order. Any chunk failure rejects the whole batch — same all-or-nothing
// semantics as the old serial loop.
export const DOWNLOAD_WINDOW = 4;

export async function fetchChunksWindowed(
  conn: RpcLike, path: string, windows: [number, number][], windowSize = DOWNLOAD_WINDOW,
  onChunkDone?: (bytes: number) => void,
): Promise<Uint8Array[]> {
  const parts: Uint8Array[] = new Array(windows.length);
  let next = 0;
  const worker = async () => {
    while (next < windows.length) {
      const i = next++;
      const [offset, len] = windows[i];
      const r = (await conn.rpc("fs.downloadChunk", { path, offset, len })) as { dataB64: string; eof: boolean; size: number };
      const bytes = fromB64(r.dataB64);
      parts[i] = bytes;
      onChunkDone?.(bytes.length);
    }
  };
  const lanes = Math.min(windowSize, windows.length);
  await Promise.all(Array.from({ length: lanes }, worker));
  return parts;
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
