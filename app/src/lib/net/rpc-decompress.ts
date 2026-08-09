// rpcZip / 带 enc 的 rpcChunk 的解码。纯函数：不碰 Connection 的任何状态。
//
// 压缩发生在服务端 Noise 加密之前的 rpc 载荷层（WS 帧里是密文，密文不可压缩）。
// 解出来的就是原样的 response 帧 JSON 文本，调用方把它回喂 dispatch 即可 ——
// resolve/reject/未知 id 丢弃这些语义因此一行都不用重写。
import { fromB64 } from "../bytes";
import { gunzip } from "../gunzip";

/**
 * 把一个 rpcZip 帧的 data 解成原始 response 帧的 JSON 文本。
 *
 * fromB64 抛的是**同步** InvalidCharacterError，gunzip 抛的是 rejected promise。
 * 这个函数是 async，所以两者都会变成 rejection —— 调用方只需要一个 .catch()。
 * 这是刻意的：若让 fromB64 的同步异常裸奔，它会从 dispatch 冒泡到 onmessage
 * （那里没有 try/catch），把整帧处理杀掉。
 */
export async function decodeZipFrame(data: string): Promise<string> {
  const bytes = fromB64(data);
  const raw = await gunzip(bytes);
  return new TextDecoder().decode(raw);
}
