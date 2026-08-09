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
import { gunzip } from "../gunzip";

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
