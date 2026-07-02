// Terminal I/O is raw bytes (may split UTF-8 mid-sequence), so we base64 it
// inside JSON control frames. Backend uses Node's Buffer (available in Bun).
export function toB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function fromB64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}
