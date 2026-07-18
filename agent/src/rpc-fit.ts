// WP-6 rpc chunking: Noise caps one message at 65535B ciphertext — 65519B
// plaintext after the 16B ChaChaPoly MAC — and cipher.js throws past it, so an
// rpc success response bigger than the safe budget cannot ride a single frame.
// Instead of shrinking known-large payloads (the WP-1 stop-gap, now removed),
// the server slices the encoded response into an rpcChunk sequence the client
// reassembles (see protocol.ts). This module holds the size constants and the
// pure slicing logic the rpc send path uses.
import { encode, type ServerMsg } from "./protocol";

// Noise transport hard cap: 65535 - 16 (MAC).
export const NOISE_MAX_PLAINTEXT_BYTES = 65519;

// Safe single-frame budget, leaving ~4KiB under the hard cap for envelope/MAC
// slack. Responses at/under this go out as one frame (the fast path); bigger
// ones are chunked.
export const RPC_FIT_SAFE_BYTES = 60 * 1024;

// Raw payload bytes per rpcChunk shard. base64 inflates a shard by 4/3 and the
// JSON envelope ({"type":"rpcChunk","id":…,"index":…,"total":…,"data":…}) adds
// ~60B plus the id and index/total digits, so a 43KiB slice lands ≈58.8KB on
// the wire — comfortably under RPC_CHUNK_FRAME_MAX_BYTES (tests pin the exact
// headroom with a worst-case id).
export const RPC_CHUNK_PAYLOAD_BYTES = 43 * 1024;

// Hard ceiling for one rpcChunk frame's plaintext bytes (JSON envelope +
// base64 shard). Well under the Noise cap, so a full-size shard always
// encrypts.
export const RPC_CHUNK_FRAME_MAX_BYTES = 60_000;

export type RpcChunk = Extract<ServerMsg, { type: "rpcChunk" }>;

// Exact encoded size of a server message — the same encode + UTF-8 bytes the
// send path feeds to the cipher. JSON.stringify does not escape non-ASCII, so
// the byte length is precise, not an estimate.
export function encodedBytes(msg: ServerMsg): number {
  return Buffer.byteLength(encode(msg), "utf8");
}

// Slice an encoded rpc response into its rpcChunk sequence: `data` is base64
// of a byte slice of the payload, shards come out in index order, `total` is
// the shard count. The cut runs on raw UTF-8 BYTES, so a boundary may split a
// multi-byte character — safe because the client concatenates the shard bytes
// first and only then JSON.parses; neither side needs character-boundary logic.
export function chunkRpcPayload(id: string, payload: string): RpcChunk[] {
  const bytes = Buffer.from(payload, "utf8");
  const total = Math.max(1, Math.ceil(bytes.length / RPC_CHUNK_PAYLOAD_BYTES));
  const chunks: RpcChunk[] = [];
  for (let index = 0; index < total; index++) {
    const slice = bytes.subarray(index * RPC_CHUNK_PAYLOAD_BYTES, (index + 1) * RPC_CHUNK_PAYLOAD_BYTES);
    chunks.push({ type: "rpcChunk", id, index, total, data: slice.toString("base64") });
  }
  return chunks;
}
