// Noise 加密前明文的第二种布局：二进制帧。
//
// 为什么需要它：rpc 载荷里的字节（gzip 结果、文件内容）此前一律用 base64 塞进
// JSON 字符串，4/3 膨胀白白多传 33%。WebSocket 层本来就是二进制
// （connection.ts 设 binaryType="arraybuffer"，SecureChannel.send 收发
// Uint8Array），JSON 只是明文的**表示形式**、不是传输格式，所以字节可以直接走。
//
// 布局：
//   [0x00][2字节头长 BE][JSON 头 UTF-8][blob 原始字节]
//
// 与 JSON 帧靠**首字节**区分：encode() 是 JSON.stringify 且 msg 恒为对象，
// 首字节必为 '{'(0x7B)，所以 0x00 永不冲突（protocol.test.ts 钉住了这条不变量）。
// 握手帧不参与判别——它们在 channel.receive 返回 status==="handshake" 时就已
// return，根本到不了嗅探那一层。
//
// 头长用 2 字节而非 3：2 字节表达 65535，上限由类型**结构性**保证，不需要一条
// 会被遗忘的运行时检查。实测真实头部 89~279 字节，绰绰有余。
export const BIN_FRAME_MAGIC = 0x00;

/** 头部最大字节数。由 2 字节长度字段结构性保证，此常量仅供调用方预检。 */
export const BIN_HEADER_MAX_BYTES = 65535;

/** 魔数 1 + 头长 2。blob 的起始偏移 = BIN_FRAME_PREFIX_BYTES + headerLen。 */
export const BIN_FRAME_PREFIX_BYTES = 3;

/**
 * 打包一个二进制帧。
 * @throws 头部序列化后超过 BIN_HEADER_MAX_BYTES 时抛 —— 这是编程错误
 *         （头里塞了不该塞的东西），不是可恢复的运行时状况。
 */
export function packBinFrame(header: object, blob: Uint8Array): Uint8Array {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  if (headerBytes.length > BIN_HEADER_MAX_BYTES) {
    throw new Error(`bin frame header too large: ${headerBytes.length}`);
  }
  const out = new Uint8Array(BIN_FRAME_PREFIX_BYTES + headerBytes.length + blob.length);
  out[0] = BIN_FRAME_MAGIC;
  out[1] = (headerBytes.length >>> 8) & 0xff;
  out[2] = headerBytes.length & 0xff;
  out.set(headerBytes, BIN_FRAME_PREFIX_BYTES);
  out.set(blob, BIN_FRAME_PREFIX_BYTES + headerBytes.length);
  return out;
}

/**
 * 解包一个二进制帧。**坏帧返回 null，绝不抛异常** —— 调用点在 onmessage，
 * 那里没有 try/catch，一个裸奔的同步异常会杀掉整帧处理。
 *
 * 返回的 blob 是**零拷贝视图**（subarray），持有整帧的底层 buffer。凡是要
 * 跨 await 或跨帧存活的调用方**必须自己 slice()**，否则一个小分片会钉住
 * 一整帧不让回收。
 */
export function unpackBinFrame(bytes: Uint8Array): { header: unknown; blob: Uint8Array } | null {
  if (bytes.length < BIN_FRAME_PREFIX_BYTES) return null;
  if (bytes[0] !== BIN_FRAME_MAGIC) return null;
  const headerLen = (bytes[1] << 8) | bytes[2];
  const blobStart = BIN_FRAME_PREFIX_BYTES + headerLen;
  if (blobStart > bytes.length) return null;
  let header: unknown;
  try {
    header = JSON.parse(
      new TextDecoder().decode(bytes.subarray(BIN_FRAME_PREFIX_BYTES, blobStart)),
    );
  } catch {
    return null;
  }
  if (typeof header !== "object" || header === null) return null;
  return { header, blob: bytes.subarray(blobStart) };
}
