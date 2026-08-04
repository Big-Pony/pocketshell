// 演示用的恒等通道：把 Noise IK 换成直通，让明文 JSON 直达 DemoAgent。
//
// 形状照抄 connection.test.ts:474 的 passthroughInitiator（那是已跑通的）。
// Connection 的握手流程要求 start() 有返回值、且要收到一帧才转 transport，
// 所以这里用两个哨兵字节演完那一出——不是加密，只是把状态机走通。
import type { SecureChannel, RecvResult } from "../lib/net/secure-channel";

export const HELLO = new Uint8Array([0x50, 0x44]);     // "PD" pocketshell-demo
export const HELLO_ACK = new Uint8Array([0x50, 0x41]); // "PA"

export function identityChannel(): SecureChannel {
  let state: SecureChannel["state"] = "handshaking";
  return {
    get state() { return state; },
    start() { return HELLO; },
    receive(frame: Uint8Array): RecvResult {
      if (state === "transport") return { status: "message", plaintext: frame };
      if (
        state === "handshaking" &&
        frame.length === HELLO_ACK.length &&
        frame[0] === HELLO_ACK[0] &&
        frame[1] === HELLO_ACK[1]
      ) {
        state = "transport";
        return { status: "handshake", established: true };
      }
      state = "failed";
      return { status: "fail", reason: "demo_handshake" };
    },
    send(plaintext: Uint8Array) { return plaintext; },
  };
}
