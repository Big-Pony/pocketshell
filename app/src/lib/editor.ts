// File-editor pure logic: CM6 language loading, chunked save, conflict
// detection. UI-free so it is unit-testable; FileEditor.svelte stays thin.
import type { Extension } from "@codemirror/state";
import { toB64 } from "./bytes";
import { CHUNK_BYTES, type RpcLike } from "./transfer";

// fs.read lang ids → CM6 extensions. bash/go/ini have no official 6.x package
// and go through legacy-modes StreamLanguage (coarser highlight, fine for edits).
const LANG_LOADERS: Record<string, () => Promise<Extension>> = {
  javascript: async () => (await import("@codemirror/lang-javascript")).javascript(),
  typescript: async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true }),
  json: async () => (await import("@codemirror/lang-json")).json(),
  markdown: async () => (await import("@codemirror/lang-markdown")).markdown(),
  python: async () => (await import("@codemirror/lang-python")).python(),
  rust: async () => (await import("@codemirror/lang-rust")).rust(),
  css: async () => (await import("@codemirror/lang-css")).css(),
  xml: async () => (await import("@codemirror/lang-xml")).xml(),
  yaml: async () => (await import("@codemirror/lang-yaml")).yaml(),
  bash: async () => {
    const [{ StreamLanguage }, { shell }] = await Promise.all([import("@codemirror/language"), import("@codemirror/legacy-modes/mode/shell")]);
    return StreamLanguage.define(shell);
  },
  go: async () => {
    const [{ StreamLanguage }, { go }] = await Promise.all([import("@codemirror/language"), import("@codemirror/legacy-modes/mode/go")]);
    return StreamLanguage.define(go);
  },
  ini: async () => {
    const [{ StreamLanguage }, { properties }] = await Promise.all([import("@codemirror/language"), import("@codemirror/legacy-modes/mode/properties")]);
    return StreamLanguage.define(properties);
  },
};

export async function langExtension(lang: string): Promise<Extension | null> {
  const loader = LANG_LOADERS[lang];
  if (!loader) return null;
  try { return await loader(); } catch { return null; } // no highlight beats no editor
}

// Byte-slicing is UTF-8-safe: the agent concatenates raw bytes before any
// decoding, so a CJK char split across two chunks re-joins intact.
export function encodeWriteChunks(text: string, chunkBytes = CHUNK_BYTES): string[] {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length === 0) return [toB64(bytes)];
  const out: string[] = [];
  for (let o = 0; o < bytes.length; o += chunkBytes) out.push(toB64(bytes.subarray(o, o + chunkBytes)));
  return out;
}

export function isConflictError(e: unknown): boolean {
  return e instanceof Error && e.message.startsWith("conflict");
}

// Serial chunked save. Editable files are ≤512KB (fs.read cap) → ≤12 chunks;
// WS ordering makes sequence numbers unnecessary. Omit expectMtime to force.
export async function saveFile(conn: RpcLike, path: string, text: string, expectMtime?: number): Promise<{ mtime: number }> {
  const chunks = encodeWriteChunks(text);
  const writeId = crypto.randomUUID();
  let result: { mtime: number } = { mtime: 0 };
  for (let i = 0; i < chunks.length; i++) {
    const last = i === chunks.length - 1;
    const params: Record<string, unknown> = { writeId, dataB64: chunks[i], first: i === 0, last };
    if (last) { params.path = path; if (expectMtime !== undefined) params.expectMtime = expectMtime; }
    const r = (await conn.rpc("fs.write", params)) as { ok?: true; mtime?: number };
    if (last) result = { mtime: r.mtime ?? 0 };
  }
  return result;
}
