// gzip 解压的唯一实现。term.history 的历史载荷与 rpc 统一压缩层共用这一份。
//
// 用浏览器原生 DecompressionStream，不引第三方压缩库（实测目标环境可用：
// Chrome 80+ / Safari 16.4+，本项目主战场是手机 Chrome）。
//
// 源用手搓的 ReadableStream 而不是 `new Blob([bytes]).stream()`：jsdom 的 Blob
// 没实现 `.stream()`（实测 `TypeError: .stream is not a function`），那会让这条
// 路径在单测里根本跑不到。ReadableStream + reader 循环是同一套 WHATWG 规范里
// 到处都有的东西，浏览器与 jsdom 都认，也不必再借道 Response.arrayBuffer()。
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  // 源的元素类型标成 BufferSource 而不是 Uint8Array：DecompressionStream 的
  // writable 在 DOM 类型里就是 `WritableStream<BufferSource>`，而 WritableStream
  // 的入参是逆变的，用更窄的 Uint8Array 会被 pipeThrough 判为不兼容。
  const src = new ReadableStream<BufferSource>({
    start(c) {
      // `as BufferSource` 是纯类型噪音的消音：TS 5.7 起 Uint8Array 带上了
      // buffer 类型参数，`Uint8Array<ArrayBufferLike>` 因而不满足要求
      // `ArrayBufferView<ArrayBuffer>` 的 BufferSource（差别只在 SharedArrayBuffer
      // 这一支，而调用方分配的永远是普通 ArrayBuffer）。运行时无影响。
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
