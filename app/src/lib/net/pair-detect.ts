// 剪贴板文本 → 是否是配对串。纯函数，包住 parsePairingString 的 ok 判定，
// 供「打开配对弹窗时预填」使用（见 DeviceManager.svelte）。
// 返回原始串而非解析结果：调用方要把它填进 textarea 让用户确认，而不是直接应用。
import { parsePairingString } from "./pairing";

export function detectPairing(text: string | null | undefined): string | null {
  if (!text) return null;
  const s = text.trim();
  return parsePairingString(s).ok ? s : null;
}
