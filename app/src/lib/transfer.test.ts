import { test, expect, vi, beforeAll } from "vitest";
import { humanSize, chunkOffsets, childPath, uploadFiles, baseName, downloadFileBlob, downloadFolder } from "./transfer";
import { toB64 } from "./bytes";

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
