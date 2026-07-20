import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { feishuSign } from "./feishu-sign";

test("matches reference HMAC(key=ts\\nsecret, msg=empty)", () => {
  const secret = "abc", ts = 1599360473;
  const ref = createHmac("sha256", `${ts}\n${secret}`).update("").digest("base64");
  expect(feishuSign(secret, ts)).toBe(ref);
});
