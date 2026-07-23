// Minimal ZIP writer that ALWAYS sets the UTF-8 (EFS) general-purpose bit-11,
// so CJK entry names decode correctly on Windows Explorer / non-EFS unzip
// tools. Apple's Info-ZIP 3.0 leaves bit-11 unset (verified: local-header GP
// flag = 0x0000), which is the 乱码 root cause. Entries are DEFLATE (method 8)
// via Node zlib; timestamps are fixed for deterministic output.
import { deflateRawSync } from "node:zlib";

export interface ZipEntry {
  name: string; // forward-slash relative path, stored as UTF-8
  data: Uint8Array;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const GP_FLAG_UTF8 = 0x0800; // bit-11 = EFS (entry name is UTF-8)
const METHOD_DEFLATE = 8;

export function buildZip(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const crc = crc32(e.data);
    const comp = new Uint8Array(deflateRawSync(Buffer.from(e.data.buffer, e.data.byteOffset, e.data.byteLength)));

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);        // local file header signature
    lh.setUint16(4, 20, true);                // version needed
    lh.setUint16(6, GP_FLAG_UTF8, true);      // general purpose bit flag (bit-11)
    lh.setUint16(8, METHOD_DEFLATE, true);    // compression method
    lh.setUint16(10, 0, true);                // mod time (fixed)
    lh.setUint16(12, 0x21, true);             // mod date (fixed 1980-01-01)
    lh.setUint32(14, crc, true);              // crc-32
    lh.setUint32(18, comp.length, true);      // compressed size
    lh.setUint32(22, e.data.length, true);    // uncompressed size
    lh.setUint16(26, nameBytes.length, true); // file name length
    lh.setUint16(28, 0, true);                // extra field length
    const lhBytes = new Uint8Array(lh.buffer);
    local.push(lhBytes, nameBytes, comp);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);        // central directory signature
    cd.setUint16(4, 20, true);                // version made by
    cd.setUint16(6, 20, true);                // version needed
    cd.setUint16(8, GP_FLAG_UTF8, true);      // general purpose bit flag (bit-11)
    cd.setUint16(10, METHOD_DEFLATE, true);
    cd.setUint16(12, 0, true);
    cd.setUint16(14, 0x21, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, comp.length, true);
    cd.setUint32(24, e.data.length, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint16(30, 0, true);                // extra field length
    cd.setUint16(32, 0, true);                // comment length
    cd.setUint16(34, 0, true);                // disk number start
    cd.setUint16(36, 0, true);                // internal attrs
    cd.setUint32(38, 0, true);                // external attrs
    cd.setUint32(42, offset, true);           // local header offset
    central.push(new Uint8Array(cd.buffer), nameBytes);

    offset += lhBytes.length + nameBytes.length + comp.length;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const c of central) centralSize += c.length;

  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);        // end of central dir signature
  eocd.setUint16(4, 0, true);
  eocd.setUint16(6, 0, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, centralStart, true);
  eocd.setUint16(20, 0, true);

  const parts = [...local, ...central, new Uint8Array(eocd.buffer)];
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
