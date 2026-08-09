// term.history 载荷的唯一解码出口。
//
// 为什么要压缩（实测，2026-08-09）：真机埋点显示这个 rpc 的 RTT 是 6.8~7.4 秒，
// 而 tmux capture-pane 只要 8ms、Noise 加密 717MB/s —— 服务端合计不到总时长的
// 0.3%，七秒全在链路上传那 179KB（134KB 的 capture 经 base64 膨胀 4/3）。
//
// 压缩必须在**加密之前**做：WS 帧里装的是 Noise 密文，密文不可压缩，去开 Bun 的
// perMessageDeflate 等于没开。所以走 rpc 载荷层。
//
// 用浏览器原生 DecompressionStream，不引第三方压缩库（实测目标环境可用：
// Chrome 80+ / Safari 16.4+，本项目主战场是手机 Chrome）。
import { fromB64 } from "../bytes";

// 源用手搓的 ReadableStream 而不是 `new Blob([bytes]).stream()`：jsdom 的 Blob
// 没实现 `.stream()`（实测 `TypeError: .stream is not a function`），那会让这条
// 路径在单测里根本跑不到。ReadableStream + reader 循环是同一套 WHATWG 规范里
// 到处都有的东西，浏览器与 jsdom 都认，也不必再借道 Response.arrayBuffer()。
async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  // 源的元素类型标成 BufferSource 而不是 Uint8Array：DecompressionStream 的
  // writable 在 DOM 类型里就是 `WritableStream<BufferSource>`，而 WritableStream
  // 的入参是逆变的，用更窄的 Uint8Array 会被 pipeThrough 判为不兼容。
  const src = new ReadableStream<BufferSource>({
    start(c) {
      // `as BufferSource` 是纯类型噪音的消音：TS 5.7 起 Uint8Array 带上了
      // buffer 类型参数，`Uint8Array<ArrayBufferLike>` 因而不满足要求
      // `ArrayBufferView<ArrayBuffer>` 的 BufferSource（差别只在 SharedArrayBuffer
      // 这一支，而 fromB64 分配的永远是普通 ArrayBuffer）。运行时无影响。
      c.enqueue(bytes as BufferSource);
      c.close();
    },
  });
  const reader = src.pipeThrough(new DecompressionStream("gzip")).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * 解出一份历史快照的文本。
 *
 * `enc` 缺省 = 未压缩（老 agent，或压缩反而更大时服务端主动回落）。
 * 认不出的 enc 按未压缩处理而不是抛错：显示乱码是可恢复的（切一下 tab 重灌），
 * 而抛错会让整个终端一片空白，那更糟。
 */
export async function decodeHistoryData(data: string, enc?: string): Promise<string> {
  if (!data) return "";
  const bytes = fromB64(data);
  const raw = enc === "gzip" ? await gunzip(bytes) : bytes;
  return new TextDecoder().decode(raw);
}
