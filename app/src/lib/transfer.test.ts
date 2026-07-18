import { test, expect, vi, beforeAll, describe } from "vitest";
import { humanSize, chunkOffsets, childPath, uploadFiles, uploadChunksWindowed, UPLOAD_WINDOW, baseName, downloadFileBlob, downloadFolder, fetchChunksWindowed, DOWNLOAD_WINDOW, CHUNK_BYTES } from "./transfer";
import { toB64, fromB64 } from "./bytes";

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
  const rpc = vi.fn(async (m: string, p: any) => { calls.push({ m, p }); return { written: 0 }; });
  const progress: [number, number][] = [];
  const blob = new Blob(["abcde"]); // 5 bytes
  await uploadFiles({ rpc } as any, "/dir", [{ name: "f.txt", size: 5, blob, destName: "f.txt" }], {
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
  const rpc = vi.fn(async () => ({ written: 0 }));
  let sent = 0;
  const orig = rpc.getMockImplementation()!;
  rpc.mockImplementation(async (...a: any[]) => { sent++; return orig(...a as [any, any]); });
  const blob = new Blob([new Uint8Array(10)]);
  await uploadFiles({ rpc } as any, "/d", [{ name: "f", size: 10, blob, destName: "f" }], {
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
  const parts = [toB64(new Uint8Array([1, 2])), toB64(new Uint8Array([3]))];
  let call = 0;
  const rpc = vi.fn(async (_m: string, p: any) => {
    if (p.len === 0) return { dataB64: "", eof: false, size: 3 }; // probe
    const dataB64 = parts[call]; const eof = call === parts.length - 1; call++;
    return { dataB64, eof, size: 3 };
  });
  const blob = await downloadFileBlob({ rpc } as any, "/f.bin", { chunkBytes: 2 });
  const buf = new Uint8Array(await blob.arrayBuffer());
  expect([...buf]).toEqual([1, 2, 3]);
  expect(rpc).toHaveBeenCalledTimes(3); // probe + 2 chunks
});

test("downloadFileBlob rejects files over MAX_TRANSFER_BYTES with a localized message", async () => {
  const rpc = vi.fn(async () => ({ dataB64: "", eof: false, size: 200 * 1024 * 1024 + 1 }));
  await expect(downloadFileBlob({ rpc } as any, "/huge.bin")).rejects.toThrow("文件超过 200MB 上限");
});

// A8: windowed download — concurrency, offset-ordered assembly, failure, progress.
test("downloadFileBlob fetches chunks concurrently and assembles in offset order despite out-of-order replies", async () => {
  const size = 8; // 4 windows of 2 bytes
  let inFlight = 0, maxInFlight = 0;
  const rpc = vi.fn(async (_m: string, p: any) => {
    if (p.len === 0) return { dataB64: "", eof: false, size }; // probe
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    // Later offsets resolve FIRST — proves assembly is by offset, not arrival.
    await new Promise((r) => setTimeout(r, (size - p.offset) * 2));
    inFlight--;
    const bytes = new Uint8Array(p.len).fill(p.offset); // mark each chunk with its offset
    return { dataB64: toB64(bytes), eof: p.offset + p.len >= size, size };
  });
  const blob = await downloadFileBlob({ rpc } as any, "/f.bin", { chunkBytes: 2, windowSize: 4 });
  const buf = [...new Uint8Array(await blob.arrayBuffer())];
  expect(buf).toEqual([0, 0, 2, 2, 4, 4, 6, 6]); // offset order preserved
  expect(maxInFlight).toBe(4); // full window actually in flight
});

test("downloadFileBlob caps concurrency at the default DOWNLOAD_WINDOW", async () => {
  const size = 20; // 10 windows of 2 bytes
  let inFlight = 0, maxInFlight = 0;
  const rpc = vi.fn(async (_m: string, p: any) => {
    if (p.len === 0) return { dataB64: "", eof: false, size };
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight--;
    return { dataB64: toB64(new Uint8Array(p.len)), eof: p.offset + p.len >= size, size };
  });
  await downloadFileBlob({ rpc } as any, "/f.bin", { chunkBytes: 2 });
  expect(maxInFlight).toBe(DOWNLOAD_WINDOW);
});

test("downloadFileBlob rejects the whole download when any chunk fails", async () => {
  const rpc = vi.fn(async (_m: string, p: any) => {
    if (p.len === 0) return { dataB64: "", eof: false, size: 6 };
    if (p.offset === 2) throw new Error("boom");
    return { dataB64: toB64(new Uint8Array(p.len)), eof: true, size: 6 };
  });
  await expect(downloadFileBlob({ rpc } as any, "/f.bin", { chunkBytes: 2, windowSize: 2 })).rejects.toThrow("boom");
});

test("downloadFileBlob reports cumulative progress per completed chunk", async () => {
  const progress: [number, number][] = [];
  const rpc = vi.fn(async (_m: string, p: any) => {
    if (p.len === 0) return { dataB64: "", eof: false, size: 4 };
    return { dataB64: toB64(new Uint8Array(p.len)), eof: true, size: 4 };
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
    return { dataB64: toB64(new Uint8Array(p.len).fill(p.offset)), eof: false, size: 6 };
  });
  const parts = await fetchChunksWindowed({ rpc } as any, "/f", windows, 1);
  expect(maxInFlight).toBe(1); // serial when window = 1
  expect(seen.sort()).toEqual([0, 2, 4]);
  expect(parts.map((b) => b[0])).toEqual([0, 2, 4]); // indexed by window position
});

describe("chunk size stays under the Noise message ceiling", () => {
  test("base64 + json envelope + MAC fits in one Noise message (<65535)", () => {
    const b64 = Math.ceil(CHUNK_BYTES / 3) * 4;
    const envelope = 300;
    const mac = 16;
    expect(b64 + envelope + mac).toBeLessThan(65535);
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
    if (m === "fs.downloadChunk") return { dataB64: toB64(new Uint8Array([9, 9])), eof: p.len > 0, size: 2 };
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
const idxOf = (dataB64: string, chunkBytes: number) => fromB64(dataB64)[0] / chunkBytes;

describe("windowed upload (WP-5)", () => {
  test("uploadFiles caps concurrency at UPLOAD_WINDOW and sends in index order despite out-of-order replies", async () => {
    const size = 16, chunkBytes = 2, n = 8;
    let inFlight = 0, maxInFlight = 0;
    const sentOrder: number[] = [];
    const rpc = vi.fn(async (_m: string, p: any) => {
      const idx = idxOf(p.dataB64, chunkBytes);
      sentOrder.push(idx); // recorded synchronously at call time = wire order
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      // Later chunks resolve FIRST — proves ordering comes from send order,
      // not from completion order.
      await new Promise((r) => setTimeout(r, (n - idx) * 2));
      inFlight--;
      return { written: 0 };
    });
    await uploadFiles({ rpc } as any, "/d", [{ name: "f", size, blob: seqBlob(size), destName: "f" }], { chunkBytes });
    expect(sentOrder).toEqual([0, 1, 2, 3, 4, 5, 6, 7]); // strictly monotonic
    expect(maxInFlight).toBe(UPLOAD_WINDOW); // full window actually in flight
  });

  test("uploadFiles sends the last chunk (with destPath) only after every other chunk settled", async () => {
    const size = 8, chunkBytes = 2, n = 4;
    let settled = 0, settledWhenLastSent = -1;
    const calls: any[] = [];
    const rpc = vi.fn(async (_m: string, p: any) => {
      calls.push(p);
      if (p.last) settledWhenLastSent = settled;
      await new Promise((r) => setTimeout(r, p.last ? 0 : 5));
      settled++;
      return { written: 0 };
    });
    await uploadFiles({ rpc } as any, "/d", [{ name: "f", size, blob: seqBlob(size), destName: "f" }], { chunkBytes, windowSize: 4 });
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
    const rpc = vi.fn(async (_m: string, p: any) => { sent.push(p); return { written: 0 }; });
    await uploadFiles({ rpc } as any, "/d", [{ name: "f", size, blob: seqBlob(size), destName: "f" }], {
      chunkBytes, windowSize: 4, shouldCancel: () => sent.length >= 2,
    });
    expect(sent.length).toBe(2); // cancelled after 2 chunks, nothing new sent afterwards
    expect(sent.every((p) => !p.last)).toBe(true); // incomplete file: no commit frame
  });

  test("uploadFiles rejects and stops sending new chunks when any chunk rpc fails", async () => {
    const size = 12, chunkBytes = 2; // 6 chunks
    const sentOrder: number[] = [];
    const rpc = vi.fn(async (_m: string, p: any) => {
      const idx = idxOf(p.dataB64, chunkBytes);
      sentOrder.push(idx);
      if (idx === 1) { await new Promise((r) => setTimeout(r, 5)); throw new Error("boom"); }
      await new Promise((r) => setTimeout(r, idx === 0 ? 50 : 0));
      return { written: 0 };
    });
    await expect(
      uploadFiles({ rpc } as any, "/d", [{ name: "f", size, blob: seqBlob(size), destName: "f" }], { chunkBytes, windowSize: 2 }),
    ).rejects.toThrow("boom");
    expect(sentOrder).toEqual([0, 1]); // nothing new issued after the failure was observed
  });

  test("uploadFiles reports cumulative progress once per completed chunk", async () => {
    const size = 8, chunkBytes = 2;
    const progress: [number, number][] = [];
    const rpc = vi.fn(async () => ({ written: 0 }));
    await uploadFiles({ rpc } as any, "/d", [{ name: "f", size, blob: seqBlob(size), destName: "f" }], {
      chunkBytes, onProgress: (u, t) => progress.push([u, t]),
    });
    expect(progress.length).toBe(4);
    for (let i = 1; i < progress.length; i++) expect(progress[i][0]).toBeGreaterThan(progress[i - 1][0]);
    expect(progress[progress.length - 1]).toEqual([8, 8]);
  });

  test("uploadFiles uploads files serially, each with its own uploadId and destPath on its last chunk", async () => {
    const calls: any[] = [];
    const rpc = vi.fn(async (_m: string, p: any) => { calls.push(p); return { written: 0 }; });
    const mk = (name: string) => ({ name, size: 4, blob: seqBlob(4), destName: name });
    await uploadFiles({ rpc } as any, "/d", [mk("a"), mk("b")], { chunkBytes: 2, windowSize: 4 });
    expect(calls.length).toBe(4); // 2 chunks per file
    expect(calls[0].uploadId).toBe(calls[1].uploadId);
    expect(calls[2].uploadId).toBe(calls[3].uploadId);
    expect(calls[0].uploadId).not.toBe(calls[2].uploadId);
    expect(idxOf(calls[1].dataB64, 2)).toBe(1); // file a's chunks precede file b's
    expect(calls[1].last).toBe(true); expect(calls[1].destPath).toBe("/d/a");
    expect(calls[3].last).toBe(true); expect(calls[3].destPath).toBe("/d/b");
  });

  test("uploadFiles sends a single first+last chunk (with destPath) for an empty file", async () => {
    const calls: any[] = [];
    const rpc = vi.fn(async (_m: string, p: any) => { calls.push(p); return { written: 0 }; });
    await uploadFiles({ rpc } as any, "/d", [{ name: "e", size: 0, blob: new Blob([]), destName: "e" }], { chunkBytes: 2 });
    expect(calls.length).toBe(1);
    expect(calls[0].first).toBe(true);
    expect(calls[0].last).toBe(true);
    expect(calls[0].destPath).toBe("/d/e");
  });

  test("uploadChunksWindowed honors a window of 1 (strictly serial)", async () => {
    const size = 8, chunkBytes = 2;
    let inFlight = 0, maxInFlight = 0;
    const sentOrder: number[] = [];
    const rpc = vi.fn(async (_m: string, p: any) => {
      sentOrder.push(idxOf(p.dataB64, chunkBytes));
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return { written: 0 };
    });
    const r = await uploadChunksWindowed({ rpc } as any, "up1", seqBlob(size), chunkOffsets(size, chunkBytes), "/d/f", { windowSize: 1 });
    expect(r).toBe("done");
    expect(maxInFlight).toBe(1);
    expect(sentOrder).toEqual([0, 1, 2, 3]);
  });
});
