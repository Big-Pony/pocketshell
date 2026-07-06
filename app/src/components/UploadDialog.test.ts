import { test, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
import UploadDialog from "./UploadDialog.svelte";

beforeAll(() => {
  // jsdom lacks Blob.prototype.arrayBuffer, which transfer.ts uses internally.
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

beforeEach(() => { (URL as any).createObjectURL = vi.fn(() => "blob:x"); (URL as any).revokeObjectURL = vi.fn(); });

function fileList(files: File[]): FileList {
  return { length: files.length, item: (i: number) => files[i], 0: files[0], [Symbol.iterator]: function* () { yield* files; } } as any;
}

test("selecting → upload with no conflicts streams then reports done", async () => {
  const rpc = vi.fn(async (m: string) => {
    if (m === "fs.uploadCheck") return { conflicts: [] };
    if (m === "fs.uploadChunk") return { written: 0 };
    return {};
  });
  const onUploaded = vi.fn();
  const { getByText, container } = render(UploadDialog, {
    props: { conn: { rpc } as any, dir: "/d", onClose: vi.fn(), onUploaded },
  });

  const input = container.querySelector('input[type=file]') as HTMLInputElement;
  const f = new File(["abc"], "a.txt");
  Object.defineProperty(input, "files", { value: fileList([f]) });
  await fireEvent.change(input);

  expect(getByText("a.txt")).toBeInTheDocument();          // selecting state lists the file
  await fireEvent.click(getByText("上传"));

  await vi.waitFor(() => expect(rpc).toHaveBeenCalledWith("fs.uploadCheck", { dir: "/d", names: ["a.txt"] }));
  await vi.waitFor(() => expect(onUploaded).toHaveBeenCalledWith("/d"));
});

test("closing while uploading cancels (onClose fires)", async () => {
  const onClose = vi.fn();
  const rpc = vi.fn(async () => ({ conflicts: [], written: 0 }));
  const { container } = render(UploadDialog, { props: { conn: { rpc } as any, dir: "/d", onClose, onUploaded: vi.fn() } });
  const input = container.querySelector('input[type=file]') as HTMLInputElement;
  Object.defineProperty(input, "files", { value: fileList([new File(["x"], "a.txt")]) });
  await fireEvent.change(input);
  // close button exists in every state
  const closeBtn = container.querySelector('[aria-label="关闭"]') as HTMLElement;
  await fireEvent.click(closeBtn);
  expect(onClose).toHaveBeenCalled();
});
