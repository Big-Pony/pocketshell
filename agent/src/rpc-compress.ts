// RPC 响应的统一压缩判定。纯函数：不碰 socket，不知道 conn 是什么。
//
// 为什么压这一层：WS 帧里装的是 Noise 密文，密文不可压缩，所以 Bun 的
// perMessageDeflate 对本项目完全无效（配上去不报错、测试也过，就是没效果）。
// 压缩只能在加密之前的 rpc 载荷层做。
//
// 为什么统一压信封而不是逐方法压字段：sendRpcResult 是方法无关的唯一出口，
// 一处改动覆盖全部方法。代价是压 base64 文本比压原始字节差 6~9%（base64 把
// 3 字节铺成 4 字符、破坏字节对齐），所以 term.history 现有的 compressHistory
// 保留不拆——那条路径压的是原始字节，效率更高。
import { encodedBytes, RPC_FIT_SAFE_BYTES } from "./rpc-fit";

/** 低于这个字节数不压：gzip 头部开销 + 客户端一次异步跳转不值当。 */
export const RPC_COMPRESS_MIN_BYTES = 8192;

// 按方法名跳过。尺寸判据能正确拒绝这些载荷（压完更大），**但 CPU 已经烧掉了**。
// fs.downloadChunk 的 dataB64 是文件字节的 base64，下载多为已压缩的媒体文件：
// 实测 45KB 分片 gzip 一次 0.78ms，200MB 下载 4552 个分片累计约 3.5 秒纯浪费，
// 而 Bun.gzipSync 是同步的、下载窗口又是 4 路并发，这 3.5 秒全砸在同一个事件
// 循环上，期间终端输入输出都会顿。
export const RPC_COMPRESS_SKIP_METHODS: ReadonlySet<string> = new Set(["fs.downloadChunk"]);

export type CompressOutcome =
  | { kind: "plain" }
  | { kind: "zip"; data: string };

// 量信封时 id 还不知道，用一个够长的占位——宁可高估几十字节，也不要低估
// 到让判据放行一个其实更大的帧。
const ID_PLACEHOLDER = "x".repeat(64);

/**
 * 决定一个已编码的 response payload 要不要压、压完什么样。
 *
 * @param payload  encode({type:"response", id, ok:true, result}) 的结果
 * @param method   本次 rpc 的方法名（用于黑名单）
 * @param acceptEnc 客户端声明的可接受编码；undefined = 老客户端，一律不压
 */
export function compressRpcPayload(
  payload: string,
  method: string,
  acceptEnc: string[] | undefined,
): CompressOutcome {
  // acceptEnc 是外部输入（协议顶层字段，decodeClient 是裸 JSON.parse 不做类型
  // 校验）：非数组值（数字/对象/字符串）必须安全回落到 plain，不能假设它是数组
  // 就直接调 .includes——字符串恰好也有 .includes，会被误当成数组接受。
  if (!Array.isArray(acceptEnc) || !acceptEnc.includes("gzip")) return { kind: "plain" };
  if (RPC_COMPRESS_SKIP_METHODS.has(method)) return { kind: "plain" };

  const rawBytes = Buffer.byteLength(payload, "utf8");
  if (rawBytes < RPC_COMPRESS_MIN_BYTES) return { kind: "plain" };

  try {
    const data = Buffer.from(Bun.gzipSync(Buffer.from(payload, "utf8"))).toString("base64");
    // 判据比的是【最终上线字节】——base64 的 4/3 回膨胀必须算进去。
    // 若改成比 gzip 的裸字节，对任何已压内容（term.history）都会判定"该压"，
    // 白白压两遍：实测那种情况裸字节 -24.5%，而真正上线的字节是 +0.6%。
    if (encodedBytes({ type: "rpcZip", id: ID_PLACEHOLDER, data }) >= rawBytes) {
      return { kind: "plain" };
    }
    return { kind: "zip", data };
  } catch {
    // 压缩失败绝不能让 rpc 失败：原样回退，客户端收到普通 response。
    return { kind: "plain" };
  }
}

/** 压缩后的 data 是否还装得下单帧（否则要走 rpcChunk 分片）。 */
export function zipFitsOneFrame(id: string, data: string): boolean {
  return encodedBytes({ type: "rpcZip", id, data }) <= RPC_FIT_SAFE_BYTES;
}
