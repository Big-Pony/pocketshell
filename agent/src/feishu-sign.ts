// Feishu custom-bot signing: the HMAC key is "<timestamp>\n<secret>" and the
// signed message is EMPTY (Feishu's documented quirk); output is base64.
import { createHmac } from "node:crypto";

export function feishuSign(secret: string, timestampSec: number): string {
  return createHmac("sha256", `${timestampSec}\n${secret}`).update("").digest("base64");
}
