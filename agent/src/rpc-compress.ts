// RPC 响应的统一压缩判定。纯函数：不碰 socket，不知道 conn 是什么。
//
// 为什么压这一层：WS 帧里装的是 Noise 密文，密文不可压缩，所以 Bun 的
// perMessageDeflate 对本项目完全无效（配上去不报错、测试也过，就是没效果）。
// 压缩只能在加密之前的 rpc 载荷层做。
//
// 为什么统一压信封而不是逐方法压字段：sendRpcResult 是方法无关的唯一出口，
// 一处改动覆盖全部方法。二阶段（二进制承载）之后，外层压缩对已被
// compressHistory 压过的载荷也真正生效——实测真实语料 inner-only 206245 →
// inner+outer 155294（省 24.7%），双层叠加优于任一单层。compressHistory 保留
// 的理由是改动最小（拆它要动两侧解码路径），而非收益：outer-only 158217，
// 只比双层大 1.9%。
import { RPC_FIT_SAFE_BYTES } from "./rpc-fit";
import { BIN_FRAME_PREFIX_BYTES } from "./binframe";

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
  | { kind: "zip"; data: Uint8Array };

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
    const data = Bun.gzipSync(Buffer.from(payload, "utf8"));
    // 判据比的是【最终上线字节】。二进制承载下 = 帧前缀 + JSON 头 + gzip 字节，
    // **没有 base64 的 4/3 膨胀**。
    //
    // 一阶段这里用的是 encodedBytes({type:"rpcZip", id, data: base64})，算出来
    // 比真实上线字节大 33%：落在 (binWire < raw ≤ b64Wire) 这个带里的载荷会被
    // 错误拒绝，而那个带恰好就是"已压缩内容"（term.history 实测 raw=182156、
    // b64 算式 183075 判不压、真实上线 137323 该压，白丢 24.6%）。
    if (binFrameBytes(ID_PLACEHOLDER, data) >= rawBytes) {
      return { kind: "plain" };
    }
    return { kind: "zip", data };
  } catch {
    // 压缩失败绝不能让 rpc 失败：原样回退，客户端收到普通 response。
    return { kind: "plain" };
  }
}

/** 一个 rpcZip 二进制帧的最终上线明文字节数。 */
function binFrameBytes(id: string, data: Uint8Array): number {
  return (
    BIN_FRAME_PREFIX_BYTES +
    Buffer.byteLength(JSON.stringify({ type: "rpcZip", id }), "utf8") +
    data.length
  );
}

/**
 * 压缩后的 data 是否还装得下单帧（否则要走 rpcChunk 分片）。
 *
 * 同样改用二进制算式：base64 算式会把 45~61KB 的 gzip 结果全判成"装不下"
 * （实测 gz=50000 在 b64 算式下算出 66704 > 61440），白白多走一轮分片往返。
 */
export function zipFitsOneFrame(id: string, data: Uint8Array): boolean {
  return binFrameBytes(id, data) <= RPC_FIT_SAFE_BYTES;
}
