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

/**
 * 跨文件共享的窗口预算（14 期需求 3）。
 *
 * 原实现 `for (const it of items) await uploadChunksWindowed(...)` 是严格串行，
 * 文件之间零重叠——每换一个文件管道就空一次（每文件 1~2 个 RTT：上一个文件的
 * 末尾 barrier 要排空，下一个文件才开始填窗）。
 *
 * 跨文件交错之所以安全：agent 的 fsUploadChunk 按 uploadId 分别落到各自的
 * `psupload-<id>.part`，不同文件的分片互不干扰。**同一文件内部**仍严格按
 * index 顺序上线（每个文件只有一个发送循环，顺序由它自己保证），末尾 barrier
 * 也只等本文件的分片结算——两条语义都没变。
 */
export type UploadBudget = { size: number; inflight: Set<Promise<void>> };

// 同时在途的文件数。2 就够消掉边界空转（A 在排 barrier 时 B 已经在填窗），
// 再多只是让预读的分片占更多内存（每个在途文件预读约一个窗口的切片）。
const FILE_PIPELINE = 2;

export async function uploadFiles(
  conn: RpcLike, dir: string, items: UploadItem[],
  opts: { chunkBytes?: number; windowSize?: number; onProgress?: (uploaded: number, total: number) => void; shouldCancel?: () => boolean } = {},
): Promise<void> {
  const chunk = opts.chunkBytes ?? CHUNK_BYTES;
  const total = items.reduce((s, it) => s + it.size, 0);
  let uploaded = 0;
  // 一个共享预算：无论几个文件在途，全局在飞的分片数仍受同一个窗口深度约束。
  const budget: UploadBudget = {
    size: Math.max(1, opts.windowSize ?? UPLOAD_WINDOW),
    inflight: new Set<Promise<void>>(),
  };
  const queue = [...items];
  let firstError: unknown = null;
  let cancelled = false;

  const runner = async () => {
    while (firstError === null && !cancelled) {
      const it = queue.shift();
      if (it === undefined) return;
      try {
        const r = await uploadChunksWindowed(
          conn, uploadId(), it.blob, chunkOffsets(it.size, chunk), childPath(dir, it.destName),
          {
            windowSize: opts.windowSize,
            shouldCancel: opts.shouldCancel,
            budget,
            onChunkDone: (n) => { uploaded += n; opts.onProgress?.(uploaded, total); },
          },
        );
        if (r === "cancelled") { cancelled = true; return; }
      } catch (e) {
        // 记下第一个错误并停下：其余 runner 在循环头看到 firstError 也会收手。
        if (firstError === null) firstError = e;
        return;
      }
    }
  };

  // runner 自己吞掉异常（存进 firstError），所以这里的 Promise.all 不会抛，
  // 也不会留下未处理的 rejection。
  await Promise.all(Array.from({ length: Math.min(FILE_PIPELINE, items.length) }, runner));
  if (firstError !== null) throw firstError;
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
  opts: {
    windowSize?: number; shouldCancel?: () => boolean; onChunkDone?: (bytes: number) => void;
    /** 跨文件共享的窗口预算（见 uploadFiles）。不传即本文件独占一个窗口，行为与从前一致。 */
    budget?: UploadBudget;
  } = {},
): Promise<"done" | "cancelled"> {
  const n = windows.length;
  if (n === 0) return "done";
  const windowSize = Math.max(1, opts.windowSize ?? UPLOAD_WINDOW);
  // 共享预算存在时，窗口容量与"在飞集合"都取共享的那一份——多个文件同时
  // 在途也不会突破同一个窗口深度。
  const cap = opts.budget?.size ?? windowSize;
  const shared = opts.budget?.inflight;

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
  // 本文件自己的在途集合：末尾 barrier 只等**本文件**的分片结算，绝不能等成
  // 共享集合里别的文件的分片（那样 barrier 语义还在，但会白等）。
  const inflight = new Set<Promise<void>>();
  // Tracked rpc promises never reject (errors land in firstError), so
  // Promise.race/all over `inflight` never throws and nothing is unhandled.
  const track = (p: Promise<unknown>, len: number) => {
    const t = p.then(
      () => { inflight.delete(t); shared?.delete(t); opts.onChunkDone?.(len); },
      (e) => { inflight.delete(t); shared?.delete(t); if (firstError === null) firstError = e; },
    );
    inflight.add(t);
    shared?.add(t);
  };

  // 等窗口腾出位置。共享预算下要等的是**全局**在飞集合——只等自己的会让
  // 每个文件各开一个满窗，n 个文件就是 n 倍窗口深度。
  const waitForSlot = async () => {
    const pool = shared ?? inflight;
    if (pool.size > 0) await Promise.race(pool);
  };

  /**
   * 同步占住一个窗口位置，返回释放函数。
   *
   * **必须在任何 await 之前占位**：从"查容量"到"真正把 rpc 记进在飞集合"
   * 之间隔着一次 `await slots[i]`（读切片），另一个文件的 runner 会在这个
   * 缝里也通过容量检查——两边都放行，峰值就冲到 cap+1（实测跨文件时 5>4）。
   * 占位用一个哨兵 promise，它同样能被 Promise.race 唤醒。
   */
  const reserveSlot = (): (() => void) => {
    if (!shared) return () => {};
    let done!: () => void;
    const sentinel = new Promise<void>((r) => { done = r; });
    shared.add(sentinel);
    return () => { shared.delete(sentinel); done(); };
  };

  // Windowed phase: every chunk except the final one.
  let i = 0;
  while (i < n - 1) {
    if (firstError !== null) break;
    if (opts.shouldCancel?.()) { cancelled = true; break; } // checked at each window boundary
    if ((shared ?? inflight).size >= cap) { await waitForSlot(); continue; }
    pumpReads(i + windowSize);
    // 先占位、再读切片：中间那次 await 是跨文件抢位的窗口期（见 reserveSlot）。
    const release = reserveSlot();
    try {
      const bytes = await slots[i]!;
      slots[i] = undefined; // free the slice as soon as it is on the wire
      track(conn.rpcBin("fs.uploadChunk", { uploadId, first: i === 0, last: false }, bytes), windows[i][1]);
      i++;
    } catch (e) { firstError = e; break; }
    finally { release(); } // rpc 已登记进在飞集合，哨兵可以退场了
  }

  // Closing barrier: the `last` chunk carries destPath and must be the last
  // frame out — only sent once every other chunk's rpc has fully settled, so
  // the server has all data appended before it commits the temp file.
  //
  // 等的是**本文件**的 inflight，不是共享预算里的全局集合：别的文件的分片
  // 落到别的 .part，与本文件的提交时机无关，等它们只会白等一轮。
  await Promise.all([...inflight]);
  if (firstError === null && !cancelled && opts.shouldCancel?.()) cancelled = true;
  if (firstError === null && !cancelled) {
    pumpReads(n);
    try {
      const bytes = await slots[n - 1]!;
      // barrier 那一片也要占共享预算的一个位置：它同样是一个在飞的 rpc，
      // 不记账的话 n 个文件各自的 barrier 会叠加到窗口之上（实测峰值 W+1）。
      while ((shared?.size ?? 0) >= cap) await waitForSlot();
      const release = reserveSlot();
      try {
        await conn.rpcBin("fs.uploadChunk", { uploadId, first: n === 1, last: true, destPath }, bytes);
        opts.onChunkDone?.(windows[n - 1][1]);
      } finally { release(); }
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
  // 14 期需求 3：**不再打零字节前置探针**。原实现为拿 size 先发一个 len:0 的
  // 请求，白付一个完整 RTT 却不搬一个字节。第一片的响应本来就带 size 字段，
  // 边取边得知总量即可 —— 小文件（一片装得下）因此从 2 个 RTT 降到 1 个。
  const head = (await conn.rpc(
    "fs.downloadChunk", { path, offset: 0, len: chunk }, { expectBytes: chunk },
  )) as DownloadChunkResult;
  // 超限校验只是从 probe 挪到第一片响应之后，**没有取消**：用户仍然在搬完
  // 整个文件之前就拿到本地化错误（最多多花一片的流量，而不是 200MB）。
  if (head.size > MAX_TRANSFER_BYTES) throw new Error(tr("errors.transfer.tooBig"));
  const first = downloadChunkBytes(head);
  // 空文件：与原 probe 分支的 `if (probe.eof) return new Blob([])` 语义等价。
  // 一片就装完时同理直接返回，不再多跑一轮窗口调度。
  if (head.size === 0 || head.eof) {
    opts.onProgress?.(first.length, head.size);
    return new Blob([first as BlobPart]);
  }
  let downloaded = first.length;
  opts.onProgress?.(downloaded, head.size);
  // 剩余分片：从第二片起。第一片已经在手上，不重复取。
  const rest = chunkOffsets(head.size, chunk).slice(1);
  const parts = await fetchChunksWindowed(conn, path, rest, opts.windowSize, (n) => {
    downloaded += n;
    opts.onProgress?.(downloaded, head.size);
  });
  return new Blob([first, ...parts] as BlobPart[]);
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
