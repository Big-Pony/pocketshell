// P2: file transfer orchestration (pure-ish; DOM download helper lives in the
// download half). All bytes travel the encrypted WS via conn.rpc/conn.rpcBin —
// chunked to stay well under the WS payload cap.
import { tr } from "../i18n";
import { fromB64 } from "../bytes";

export const MAX_TRANSFER_BYTES = 200 * 1024 * 1024;

// Chunk size is bounded by the Noise transport: SecureChannel encrypts each RPC
// as ONE ChaChaPoly message, and noise-handshake hard-caps ciphertext at 65535
// bytes (plaintext ≤ 65519).
//
// 14 期需求 3：45KB → 56KB。45KB 是 base64 时代的尺寸（一片 45KB × 4/3 =
// 上线 61.5KB，正好卡在安全线上）；二进制帧改造后不再有 4/3 膨胀，一片 45KB
// 上线仅约 46KB，白白空着 15KB 预算。**同样的往返次数多搬 24% 字节**——
// RTT 受限的链路上这是纯收益。
//
// ⚠️ 为什么是 56KB 而不是更大：真正卡死尺寸的**不是** Noise 硬上限（65519），
// 是 agent 侧 sendRpcBinary 的 `frameBytes <= RPC_FIT_SAFE_BYTES`(61440)——
// 超了它会**静默回落**到 base64 塞 dataB64 的老路径，4/3 膨胀外加再走一遍
// 压缩/分片，比不提尺寸还慢，而且没有任何报错。下行最坏帧 = 3(前缀) +
// 77(rpcBin 头) + chunk，60KB 时是 61520B > 61440B，正好踩进这个陷阱
// （Noise 那关反而过得去，余量 3999B——所以只看 Noise 会得出错误结论）。
// 56KB 时下行 57424B、上行 57819B，两道线都留 4KB 以上余量。
// 最坏帧由 agent/src/rpc-fit.test.ts 的两条断言钉死，加 header 字段会当场翻车。
export const CHUNK_BYTES = 56 * 1024;

export type RpcLike = {
  // opts.expectBytes：预期响应体字节数，喂给 rpc 死线的排队记账。只有下载
  // 分片这类"调用方本就知道会拿回多少字节"的路径需要传（见 connection.ts）。
  rpc(method: string, params?: unknown, opts?: { expectBytes?: number }): Promise<unknown>;
  rpcBin(method: string, params: unknown, blob: Uint8Array): Promise<unknown>;
};
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
//
// 14 期需求 3：4 → 16。吞吐天花板 = 窗口 × 分片 ÷ RTT，与链路带宽无关
// （用户实测"开 VPN 也一样"正是这个特征）。RTT=150ms 的公网链路上
// 4×45KB 只能跑 1.17MB/s（限速中继实测 1.05MB/s，与算式吻合），
// 16×56KB 的天花板是 5.8MB/s。
//
// 16 由两条约束夹出，不是拍的：
//   内存 —— 16 × 56KB = 896KB in-flight，手机可接受（整个文件本来就驻留内存）。
//   死线 —— 满载 inflightBytes ≈ 918KB → rpcDeadlineMs 约 147s，仍在
//           RPC_MAX_TIMEOUT_MS(5min) 之内。
// 不再往上：sendRpcResult 路径**完全无背压**（server.ts 自述"客户端的 rpc
// 超时是唯一兜底"），窗口过深会让 agent 无节制往 socket 灌。
export const UPLOAD_WINDOW = 16;

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
      track(conn.rpcBin("fs.uploadChunk", { uploadId, first: i === 0, last: false }, bytes), windows[i][1]);
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
      await conn.rpcBin("fs.uploadChunk", { uploadId, first: n === 1, last: true, destPath }, bytes);
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

// fs.downloadChunk 正常回复走 rpcBin，result.bytes 是裸字节。但 agent 的
// sendRpcBinary 在两种情况下回落到一阶段的形状——单帧装不下（frameBytes >
// RPC_FIT_SAFE_BYTES，len 无客户端可控的独立上限）、或客户端没声明 "bin"
// 能力——把字节 base64 塞进 result.dataB64，走既有的压缩/分片 JSON 链路
// （见 server.ts 的 sendRpcBinary）。今天的 UI 走不到这条路径（CHUNK_BYTES
// 是 56KiB，最坏下行帧 57424B，仍在 RPC_FIT_SAFE_BYTES 61440 之内、余约 4KB），
// 但它是会大声失败的死代码、调大 chunkBytes 即触发，两种形状都要认得。
type DownloadChunkResult = { bytes?: Uint8Array; dataB64?: string; eof: boolean; size: number };
function downloadChunkBytes(r: DownloadChunkResult): Uint8Array {
  return r.bytes ?? fromB64(r.dataB64 ?? "");
}

export async function downloadFileBlob(
  conn: RpcLike, path: string,
  opts: { chunkBytes?: number; windowSize?: number; onProgress?: (downloaded: number, total: number) => void } = {},
): Promise<Blob> {
  const chunk = opts.chunkBytes ?? CHUNK_BYTES;
  // Pre-check size so the user gets a localized error before any real bytes flow.
  const probe = (await conn.rpc("fs.downloadChunk", { path, offset: 0, len: 0 })) as DownloadChunkResult;
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
// 14 期需求 3：4 → 16，推导与内存/死线两条约束见 UPLOAD_WINDOW 上方的注释。
// 下行侧还有一条上行没有的前提：**必须与 rpc() 的 expectBytes 记账同批落地**。
// 16 lane 各等一个 56KB 的响应体，若响应体不入账、死线恒为 10s，要下行
// ≥716kbps 才不超时——不修死线光提窗口，慢链路下载失败率反而上升。
export const DOWNLOAD_WINDOW = 16;

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
      const r = (await conn.rpc(
        "fs.downloadChunk",
        { path, offset, len },
        // 响应体就是这么多字节，让死线把它算进去。不传的话 16 lane 并发
        // 每个都以为只排了 150 字节，死线全塌回 10s 下限。
        { expectBytes: len },
      )) as DownloadChunkResult;
      // 不需要在这里 slice：handleRpcBin 在 resolve 前已经 slice 过一次真拷贝
      // （因为 blob 要跨帧存活到整个文件下载完）。这里再 slice 是白拷一遍。
      // 若哪天有人「优化」掉 handleRpcBin 里那次 slice，这些 parts 会各自钉住
      // 一整帧的底层 buffer —— 4552 个分片 × 整帧，那才是问题。
      // dataB64 回落分支没有这个顾虑：fromB64 本来就产出一份新分配的字节。
      const bytes = downloadChunkBytes(r);
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
