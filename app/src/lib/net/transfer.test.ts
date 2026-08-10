import { test, expect, vi, beforeAll, describe } from "vitest";
import { humanSize, chunkOffsets, childPath, uploadFiles, uploadChunksWindowed, UPLOAD_WINDOW, baseName, downloadFileBlob, downloadFolder, fetchChunksWindowed, DOWNLOAD_WINDOW, CHUNK_BYTES, type RpcLike } from "./transfer";
import { toB64 } from "../bytes";

beforeAll(() => {
  // jsdom does not implement Blob.prototype.arrayBuffer; polyfill it via
  // FileReader so transfer.ts unit tests can run without touching real DOM.
  if (!(Blob.prototype as any).arrayBuffer) {
    (Blob.prototype as any).arrayBuffer = function (this: Blob): Promise<ArrayBuffer> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = reject;
        reader.readAsArrayBuffer(this);
      });
    };
  }
});

test("humanSize formats B/KB/MB", () => {
  expect(humanSize(512)).toBe("512 B");
  expect(humanSize(2048)).toBe("2.0 KB");
  expect(humanSize(3 * 1024 * 1024)).toBe("3.0 MB");
});

test("chunkOffsets splits size into [offset,len] windows", () => {
  expect(chunkOffsets(10, 4)).toEqual([[0, 4], [4, 4], [8, 2]]);
  expect(chunkOffsets(0, 4)).toEqual([[0, 0]]); // empty file → one empty chunk
});

test("childPath joins under root and under '/'", () => {
  expect(childPath("/a/b", "c.txt")).toBe("/a/b/c.txt");
  expect(childPath("/", "c.txt")).toBe("/c.txt");
});

test("uploadFiles chunks each file, flags first/last, reports aggregate progress", async () => {
  const calls: any[] = [];
  const rpcBin = vi.fn(async (m: string, p: any, bytes: Uint8Array) => { calls.push({ m, p, bytes }); return { written: 0 }; });
  const progress: [number, number][] = [];
  const blob = new Blob(["abcde"]); // 5 bytes
  await uploadFiles({ rpcBin } as any, "/dir", [{ name: "f.txt", size: 5, blob, destName: "f.txt" }], {
    chunkBytes: 2, onProgress: (u, t) => progress.push([u, t]),
  });
  const chunks = calls.filter((c) => c.m === "fs.uploadChunk");
  expect(chunks.length).toBe(3);              // 2+2+1
  expect(chunks[0].p.first).toBe(true);
  expect(chunks[0].p.last).toBeFalsy();
  expect(chunks[2].p.last).toBe(true);
  expect(chunks[2].p.destPath).toBe("/dir/f.txt");
  expect(progress[progress.length - 1]).toEqual([5, 5]);
});

test("uploadFiles stops early when shouldCancel() turns true", async () => {
  // Typed with RpcLike's own signature so the recorded wrapper can forward the
  // real (method, params, blob) triple — a bare `async () => …` mock takes 0 args.
  const rpcBin = vi.fn<RpcLike["rpcBin"]>(async () => ({ written: 0 }));
  let sent = 0;
  const orig = rpcBin.getMockImplementation()!;
  rpcBin.mockImplementation(async (method, params, blob) => { sent++; return orig(method, params, blob); });
  const blob = new Blob([new Uint8Array(10)]);
  await uploadFiles({ rpcBin } as unknown as RpcLike, "/d", [{ name: "f", size: 10, blob, destName: "f" }], {
    chunkBytes: 2, shouldCancel: () => sent >= 2, // cancel after 2 chunks
  });
  expect(sent).toBeLessThan(5); // did not send all 5 chunks
});

test("baseName returns last segment, falls back to 'root' for '/'", () => {
  expect(baseName("/a/b/proj")).toBe("proj");
  expect(baseName("/x")).toBe("x");
  expect(baseName("/")).toBe("root");
});

test("downloadFileBlob probes size then concatenates chunks until eof", async () => {
  const parts = [new Uint8Array([1, 2]), new Uint8Array([3])];
  let call = 0;
  const rpc = vi.fn(async (_m: string, p: any) => {
    if (p.len === 0) return { bytes: new Uint8Array(0), eof: false, size: 3 }; // probe
    const bytes = parts[call]; const eof = call === parts.length - 1; call++;
    return { bytes, eof, size: 3 };
  });
  const blob = await downloadFileBlob({ rpc } as any, "/f.bin", { chunkBytes: 2 });
  const buf = new Uint8Array(await blob.arrayBuffer());
  expect([...buf]).toEqual([1, 2, 3]);
  expect(rpc).toHaveBeenCalledTimes(3); // probe + 2 chunks
});

test("downloadFileBlob rejects files over MAX_TRANSFER_BYTES with a localized message", async () => {
  const rpc = vi.fn(async () => ({ bytes: new Uint8Array(0), eof: false, size: 200 * 1024 * 1024 + 1 }));
  await expect(downloadFileBlob({ rpc } as any, "/huge.bin")).rejects.toThrow("文件超过 200MB 上限");
});

// A8: windowed download — concurrency, offset-ordered assembly, failure, progress.
test("downloadFileBlob fetches chunks concurrently and assembles in offset order despite out-of-order replies", async () => {
  const size = 8; // 4 windows of 2 bytes
  let inFlight = 0, maxInFlight = 0;
  const rpc = vi.fn(async (_m: string, p: any) => {
    if (p.len === 0) return { bytes: new Uint8Array(0), eof: false, size }; // probe
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    // Later offsets resolve FIRST — proves assembly is by offset, not arrival.
    await new Promise((r) => setTimeout(r, (size - p.offset) * 2));
    inFlight--;
    const bytes = new Uint8Array(p.len).fill(p.offset); // mark each chunk with its offset
    return { bytes, eof: p.offset + p.len >= size, size };
  });
  const blob = await downloadFileBlob({ rpc } as any, "/f.bin", { chunkBytes: 2, windowSize: 4 });
  const buf = [...new Uint8Array(await blob.arrayBuffer())];
  expect(buf).toEqual([0, 0, 2, 2, 4, 4, 6, 6]); // offset order preserved
  expect(maxInFlight).toBe(4); // full window actually in flight
});

test("downloadFileBlob caps concurrency at the default DOWNLOAD_WINDOW", async () => {
  // 分片数必须多于窗口深度，否则测的是"文件不够长"而不是"窗口封顶"
  // （14 期把窗口从 4 提到 16，原本的 10 片就不够了）。
  const size = DOWNLOAD_WINDOW * 2 * 2; // 2×窗口 个分片，每片 2 字节
  let inFlight = 0, maxInFlight = 0;
  const rpc = vi.fn(async (_m: string, p: any) => {
    if (p.len === 0) return { bytes: new Uint8Array(0), eof: false, size };
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight--;
    return { bytes: new Uint8Array(p.len), eof: p.offset + p.len >= size, size };
  });
  await downloadFileBlob({ rpc } as any, "/f.bin", { chunkBytes: 2 });
  expect(maxInFlight).toBe(DOWNLOAD_WINDOW);
});

test("downloadFileBlob rejects the whole download when any chunk fails", async () => {
  const rpc = vi.fn(async (_m: string, p: any) => {
    if (p.len === 0) return { bytes: new Uint8Array(0), eof: false, size: 6 };
    if (p.offset === 2) throw new Error("boom");
    return { bytes: new Uint8Array(p.len), eof: true, size: 6 };
  });
  await expect(downloadFileBlob({ rpc } as any, "/f.bin", { chunkBytes: 2, windowSize: 2 })).rejects.toThrow("boom");
});

test("downloadFileBlob reports cumulative progress per completed chunk", async () => {
  const progress: [number, number][] = [];
  const rpc = vi.fn(async (_m: string, p: any) => {
    if (p.len === 0) return { bytes: new Uint8Array(0), eof: false, size: 4 };
    return { bytes: new Uint8Array(p.len), eof: true, size: 4 };
  });
  await downloadFileBlob({ rpc } as any, "/f", { chunkBytes: 2, onProgress: (d, t) => progress.push([d, t]) });
  expect(progress.length).toBe(2);
  expect(progress[progress.length - 1]).toEqual([4, 4]);
});

test("fetchChunksWindowed leaves no window unfetched and honors a window of 1", async () => {
  const windows = chunkOffsets(6, 2); // [[0,2],[2,2],[4,2]]
  const seen: number[] = [];
  let inFlight = 0, maxInFlight = 0;
  const rpc = vi.fn(async (_m: string, p: any) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight--;
    seen.push(p.offset);
    return { bytes: new Uint8Array(p.len).fill(p.offset), eof: false, size: 6 };
  });
  const parts = await fetchChunksWindowed({ rpc } as any, "/f", windows, 1);
  expect(maxInFlight).toBe(1); // serial when window = 1
  expect(seen.sort()).toEqual([0, 2, 4]);
  expect(parts.map((b) => b[0])).toEqual([0, 2, 4]); // indexed by window position
});

describe("chunk size stays under the Noise message ceiling", () => {
  // 二阶段起 chunk 走二进制帧尾（不再 base64），开销只是 3 字节前缀 + JSON 头，
  // 不再有 base64 的 ×4/3 膨胀。
  test("raw chunk + binary frame prefix/header + MAC fits in one Noise message (<65535)", () => {
    const prefix = 3; // BIN_FRAME_PREFIX_BYTES
    const header = 300; // generous JSON header (type/id/method/params/acceptEnc)
    const mac = 16;
    expect(CHUNK_BYTES + prefix + header + mac).toBeLessThan(65535);
  });
  test("splits a 700KB file into multiple chunks", () => {
    const windows = chunkOffsets(700 * 1024, CHUNK_BYTES);
    expect(windows.length).toBeGreaterThan(1);
  });
});

test("downloadFolder archives, downloads, then deletes the temp archive", async () => {
  const order: string[] = [];
  const rpc = vi.fn(async (m: string, p: any) => {
    order.push(m);
    if (m === "fs.archive") return { archivePath: "/tmp/psarchive-x.zip", size: 2 };
    if (m === "fs.downloadChunk") return { bytes: new Uint8Array([9, 9]), eof: p.len > 0, size: 2 };
    if (m === "fs.op") return { ok: true };
    return {};
  });
  // triggerBrowserDownload touches document/URL — stub them for jsdom.
  const origCreate = URL.createObjectURL; const origRevoke = URL.revokeObjectURL;
  (URL as any).createObjectURL = vi.fn(() => "blob:x");
  (URL as any).revokeObjectURL = vi.fn();
  const busy: boolean[] = [];
  await downloadFolder({ rpc } as any, "/a/proj", { onArchiving: (b) => busy.push(b) });
  (URL as any).createObjectURL = origCreate; (URL as any).revokeObjectURL = origRevoke;
  expect(order).toEqual(["fs.archive", "fs.downloadChunk", "fs.downloadChunk", "fs.op"]); // probe + single chunk
  expect(busy).toEqual([true, false]); // spinner on then off
});

// WP-5: windowed upload — concurrency cap, monotonic wire order, closing
// barrier for the last chunk, cancel, failure, progress. Chunk contents are
// identifiable because seqBlob sets byte[offset] = offset, so a chunk's first
// byte / chunkBytes is its index.
const seqBlob = (size: number) => new Blob([Uint8Array.from({ length: size }, (_, o) => o)]);
const idxOf = (bytes: Uint8Array, chunkBytes: number) => bytes[0] / chunkBytes;

describe("windowed upload (WP-5)", () => {
  test("uploadFiles caps concurrency at UPLOAD_WINDOW and sends in index order despite out-of-order replies", async () => {
    // 分片数必须多于窗口深度（末尾 barrier 那片不参与窗口，所以要 n-1 ≥ 窗口），
    // 否则测的是"文件不够长"而不是"窗口封顶"——14 期把窗口从 4 提到 16 时
    // 原本的 8 片当场不够用了。
    const chunkBytes = 2, n = UPLOAD_WINDOW * 2, size = chunkBytes * n;
    let inFlight = 0, maxInFlight = 0;
    const sentOrder: number[] = [];
    const rpcBin = vi.fn(async (_m: string, _p: any, bytes: Uint8Array) => {
      const idx = idxOf(bytes, chunkBytes);
      sentOrder.push(idx); // recorded synchronously at call time = wire order
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      // Later chunks resolve FIRST — proves ordering comes from send order,
      // not from completion order.
      await new Promise((r) => setTimeout(r, (n - idx) * 2));
      inFlight--;
      return { written: 0 };
    });
    await uploadFiles({ rpcBin } as any, "/d", [{ name: "f", size, blob: seqBlob(size), destName: "f" }], { chunkBytes });
    expect(sentOrder).toEqual(Array.from({ length: n }, (_, i) => i)); // strictly monotonic
    expect(maxInFlight).toBe(UPLOAD_WINDOW); // full window actually in flight
  });

  test("uploadFiles sends the last chunk (with destPath) only after every other chunk settled", async () => {
    const size = 8, chunkBytes = 2, n = 4;
    let settled = 0, settledWhenLastSent = -1;
    const calls: any[] = [];
    const rpcBin = vi.fn(async (_m: string, p: any, bytes: Uint8Array) => {
      calls.push({ ...p, bytes });
      if (p.last) settledWhenLastSent = settled;
      await new Promise((r) => setTimeout(r, p.last ? 0 : 5));
      settled++;
      return { written: 0 };
    });
    await uploadFiles({ rpcBin } as any, "/d", [{ name: "f", size, blob: seqBlob(size), destName: "f" }], { chunkBytes, windowSize: 4 });
    expect(settledWhenLastSent).toBe(n - 1); // closing barrier: all prior chunks done
    expect(calls[0].first).toBe(true);
    expect(calls[0].last).toBe(false);
    expect(calls[n - 1].last).toBe(true);
    expect(calls[n - 1].destPath).toBe("/d/f");
    expect(calls.filter((c) => c.last).length).toBe(1);
  });

  test("uploadFiles stops issuing new chunks when shouldCancel flips at a window boundary", async () => {
    const size = 20, chunkBytes = 2; // 10 chunks
    const sent: any[] = [];
    const rpcBin = vi.fn(async (_m: string, p: any) => { sent.push(p); return { written: 0 }; });
    await uploadFiles({ rpcBin } as any, "/d", [{ name: "f", size, blob: seqBlob(size), destName: "f" }], {
      chunkBytes, windowSize: 4, shouldCancel: () => sent.length >= 2,
    });
    expect(sent.length).toBe(2); // cancelled after 2 chunks, nothing new sent afterwards
    expect(sent.every((p) => !p.last)).toBe(true); // incomplete file: no commit frame
  });

  test("uploadFiles rejects and stops sending new chunks when any chunk rpc fails", async () => {
    const size = 12, chunkBytes = 2; // 6 chunks
    const sentOrder: number[] = [];
    const rpcBin = vi.fn(async (_m: string, _p: any, bytes: Uint8Array) => {
      const idx = idxOf(bytes, chunkBytes);
      sentOrder.push(idx);
      if (idx === 1) { await new Promise((r) => setTimeout(r, 5)); throw new Error("boom"); }
      await new Promise((r) => setTimeout(r, idx === 0 ? 50 : 0));
      return { written: 0 };
    });
    await expect(
      uploadFiles({ rpcBin } as any, "/d", [{ name: "f", size, blob: seqBlob(size), destName: "f" }], { chunkBytes, windowSize: 2 }),
    ).rejects.toThrow("boom");
    expect(sentOrder).toEqual([0, 1]); // nothing new issued after the failure was observed
  });

  test("uploadFiles reports cumulative progress once per completed chunk", async () => {
    const size = 8, chunkBytes = 2;
    const progress: [number, number][] = [];
    const rpcBin = vi.fn(async () => ({ written: 0 }));
    await uploadFiles({ rpcBin } as any, "/d", [{ name: "f", size, blob: seqBlob(size), destName: "f" }], {
      chunkBytes, onProgress: (u, t) => progress.push([u, t]),
    });
    expect(progress.length).toBe(4);
    for (let i = 1; i < progress.length; i++) expect(progress[i][0]).toBeGreaterThan(progress[i - 1][0]);
    expect(progress[progress.length - 1]).toEqual([8, 8]);
  });

  test("uploadFiles uploads files serially, each with its own uploadId and destPath on its last chunk", async () => {
    const calls: any[] = [];
    const rpcBin = vi.fn(async (_m: string, p: any, bytes: Uint8Array) => { calls.push({ ...p, bytes }); return { written: 0 }; });
    const mk = (name: string) => ({ name, size: 4, blob: seqBlob(4), destName: name });
    await uploadFiles({ rpcBin } as any, "/d", [mk("a"), mk("b")], { chunkBytes: 2, windowSize: 4 });
    expect(calls.length).toBe(4); // 2 chunks per file
    expect(calls[0].uploadId).toBe(calls[1].uploadId);
    expect(calls[2].uploadId).toBe(calls[3].uploadId);
    expect(calls[0].uploadId).not.toBe(calls[2].uploadId);
    expect(idxOf(calls[1].bytes, 2)).toBe(1); // file a's chunks precede file b's
    expect(calls[1].last).toBe(true); expect(calls[1].destPath).toBe("/d/a");
    expect(calls[3].last).toBe(true); expect(calls[3].destPath).toBe("/d/b");
  });

  test("uploadFiles sends a single first+last chunk (with destPath) for an empty file", async () => {
    const calls: any[] = [];
    const rpcBin = vi.fn(async (_m: string, p: any) => { calls.push(p); return { written: 0 }; });
    await uploadFiles({ rpcBin } as any, "/d", [{ name: "e", size: 0, blob: new Blob([]), destName: "e" }], { chunkBytes: 2 });
    expect(calls.length).toBe(1);
    expect(calls[0].first).toBe(true);
    expect(calls[0].last).toBe(true);
    expect(calls[0].destPath).toBe("/d/e");
  });

  test("uploadChunksWindowed honors a window of 1 (strictly serial)", async () => {
    const size = 8, chunkBytes = 2;
    let inFlight = 0, maxInFlight = 0;
    const sentOrder: number[] = [];
    const rpcBin = vi.fn(async (_m: string, _p: any, bytes: Uint8Array) => {
      sentOrder.push(idxOf(bytes, chunkBytes));
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return { written: 0 };
    });
    const r = await uploadChunksWindowed({ rpcBin } as any, "up1", seqBlob(size), chunkOffsets(size, chunkBytes), "/d/f", { windowSize: 1 });
    expect(r).toBe("done");
    expect(maxInFlight).toBe(1);
    expect(sentOrder).toEqual([0, 1, 2, 3]);
  });
});

test("上传走 rpcBin，字节不经 base64", async () => {
  const calls: { method: string; params: any; blob?: Uint8Array }[] = [];
  const conn = {
    rpc: async (method: string, params: unknown) => { calls.push({ method, params }); return {}; },
    rpcBin: async (method: string, params: unknown, blob: Uint8Array) => {
      calls.push({ method, params, blob }); return {};
    },
  };
  const EVIL = new Uint8Array([0xed, 0xa0, 0x80, 0xff, 0xfe]);
  await uploadChunksWindowed(conn as any, "u1", new Blob([EVIL]), [[0, EVIL.length]], "/dest", {});
  const up = calls.filter((c) => c.method === "fs.uploadChunk");
  expect(up.length).toBe(1);
  expect(up[0].blob).toBeDefined();
  expect(Array.from(up[0].blob!)).toEqual(Array.from(EVIL));
  expect(up[0].params.dataB64).toBeUndefined(); // 不再有 base64 字段
});

test("下载读 r.bytes，不再 fromB64", async () => {
  const EVIL = new Uint8Array([0xed, 0xa0, 0x80, 0xff, 0xfe, 0x00]);
  const conn = {
    rpc: async (_m: string, p: any) => {
      if (p.len === 0) return { bytes: new Uint8Array(0), eof: false, size: EVIL.length };
      return { bytes: EVIL, eof: true, size: EVIL.length };
    },
  };
  const blob = await downloadFileBlob(conn as any, "/a");
  const got = new Uint8Array(await blob.arrayBuffer());
  expect(Array.from(got)).toEqual(Array.from(EVIL));
});

test("fs.downloadChunk 回落到 dataB64（单帧装不下或客户端没声明 bin 时 sendRpcBinary 的形状）也能拼出正确字节", async () => {
  // 回归用例：sendRpcBinary 在两种情况下不发二进制帧，改走 sendRpcResult 把
  // 字节 base64 进 result.dataB64（没有 bytes 字段）——见 agent/src/server.ts。
  // 今天的 downloadFileBlob 硬编码 45KiB 分片，帧预算绰绰有余，永远走不到这条
  // 路径，但只要有人调大 chunkBytes 就会撞上；之前 transfer.ts 只读 r.bytes，
  // 这种回复会静默产出空字节而不是报错。
  const EVIL = new Uint8Array([0xed, 0xa0, 0x80, 0xff, 0xfe, 0x00]);
  const conn = {
    rpc: async (_m: string, p: any) => {
      if (p.len === 0) return { dataB64: toB64(new Uint8Array(0)), eof: false, size: EVIL.length };
      return { dataB64: toB64(EVIL), eof: true, size: EVIL.length };
    },
  };
  const blob = await downloadFileBlob(conn as any, "/a");
  const got = new Uint8Array(await blob.arrayBuffer());
  expect(Array.from(got)).toEqual(Array.from(EVIL));
});

// ---------------------------------------------------------------------------
// 14 期需求 3：窗口 4→16。吞吐天花板 = 窗口 × 分片 ÷ RTT，与链路带宽无关——
// 用户实测"开 VPN 也一样"正是这个特征。
// RTT=150ms 下：4×46080/0.15 ≈ 1.17MB/s → 16×57344/0.15 ≈ 5.8MB/s。
describe("传输窗口深度（14 期需求 3）", () => {
  test("上传/下载窗口都是 16", () => {
    expect(UPLOAD_WINDOW).toBe(16);
    expect(DOWNLOAD_WINDOW).toBe(16);
  });

  test("上传并发真的用满窗口且不越界", async () => {
    let peak = 0, cur = 0;
    const conn = {
      rpc: vi.fn(async () => ({})),
      rpcBin: vi.fn(async () => {
        cur++; peak = Math.max(peak, cur);
        await new Promise((r) => setTimeout(r, 5));
        cur--;
        return {};
      }),
    };
    // 40 片：足够多，窗口能被填满好几轮。用 2 字节的假分片跑，省内存——
    // 窗口调度与分片真实大小无关。
    const chunkBytes = 2, n = 40;
    const blob = seqBlob(chunkBytes * n);
    await uploadChunksWindowed(
      conn as never, "uid", blob,
      chunkOffsets(blob.size, chunkBytes), "/dst",
    );
    expect(peak).toBeLessThanOrEqual(UPLOAD_WINDOW);
    expect(peak, "应真的用满窗口而不是仍旧 4 路").toBeGreaterThan(4);
  });

  test("下载并发真的用满窗口且不越界", async () => {
    const chunkBytes = 2, n = 40, size = chunkBytes * n;
    let peak = 0, cur = 0;
    const conn = {
      rpc: vi.fn(async (_m: string, p: any) => {
        cur++; peak = Math.max(peak, cur);
        await new Promise((r) => setTimeout(r, 5));
        cur--;
        return { bytes: new Uint8Array(p.len), eof: p.offset + p.len >= size, size };
      }),
    };
    await downloadFileBlob(conn as never, "/f.bin", { chunkBytes });
    expect(peak).toBeLessThanOrEqual(DOWNLOAD_WINDOW);
    expect(peak, "应真的用满窗口而不是仍旧 4 路").toBeGreaterThan(4);
  });

  // last:true 那片携带 destPath，agent 收到即把临时文件提交为正式文件
  // （fs-service.ts 的 copyFileSync）。它必须在其余所有分片**结算之后**才发
  // 出——否则会提交出内容不完整的文件，且**失败是静默的**（文件就在那里，
  // 只是短了一截）。这条断言锁住这个语义，防止后来者把末尾 barrier
  // "优化"进窗口调度。窗口提到 16 之后尤其要紧：一次能有 16 片在飞。
  test("last 分片在所有其他分片结算后才发出（末尾 barrier 不可优化）", async () => {
    const order: string[] = [];
    let settled = 0;
    const conn = {
      rpc: vi.fn(async () => ({})),
      rpcBin: vi.fn(async (_m: string, p: any) => {
        if (p.last) order.push(`last@${settled}`);
        await new Promise((r) => setTimeout(r, 3));
        settled++;
        return {};
      }),
    };
    const chunkBytes = 2, n = 10;
    const blob = seqBlob(chunkBytes * n);
    await uploadChunksWindowed(
      conn as never, "uid", blob,
      chunkOffsets(blob.size, chunkBytes), "/dst",
    );
    // 发 last 的那一刻，前 n-1 片必须已经全部结算。
    expect(order).toEqual([`last@${n - 1}`]);
  });
});
