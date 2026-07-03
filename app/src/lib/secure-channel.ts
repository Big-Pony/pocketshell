// B1.5 SecureChannel (initiator). Mirror of agent/src/secure-channel.ts; keeps
// crypto out of connection.ts. Interface kept byte-identical to the backend.
import Noise from "noise-handshake";
import Cipher from "noise-handshake/cipher";

const PROLOGUE = Buffer.from("pocketshell-v1");

export type RecvResult =
  | { status: "handshake"; reply?: Uint8Array; established?: boolean }
  | { status: "message"; plaintext: Uint8Array }
  | { status: "fail"; reason: string };

export interface SecureChannel {
  readonly state: "handshaking" | "transport" | "failed";
  start(): Uint8Array | null;
  receive(frame: Uint8Array): RecvResult;
  send(plaintext: Uint8Array): Uint8Array;
}

export function createInitiatorChannel(opts: {
  identity: { publicKey: Uint8Array; secretKey: Uint8Array };
  agentPublicKey: Uint8Array;
}): SecureChannel {
  const hs = new Noise("IK", true, {
    publicKey: Buffer.from(opts.identity.publicKey),
    secretKey: Buffer.from(opts.identity.secretKey),
  });
  hs.initialise(PROLOGUE, Buffer.from(opts.agentPublicKey));
  let state: SecureChannel["state"] = "handshaking";
  let tx: Cipher | null = null;
  let rx: Cipher | null = null;

  return {
    get state() { return state; },
    start() {
      return new Uint8Array(hs.send()); // msg1
    },
    receive(frame) {
      if (state === "transport") {
        try {
          return { status: "message", plaintext: new Uint8Array(rx!.decrypt(Buffer.from(frame))) };
        } catch {
          state = "failed";
          return { status: "fail", reason: "decrypt_failed" };
        }
      }
      if (state !== "handshaking") return { status: "fail", reason: "bad_state" };
      try {
        hs.recv(Buffer.from(frame)); // msg2
      } catch {
        state = "failed";
        return { status: "fail", reason: "handshake_error" };
      }
      tx = new Cipher(hs.tx);
      rx = new Cipher(hs.rx);
      state = "transport";
      return { status: "handshake", established: true };
    },
    send(plaintext) {
      if (state !== "transport") throw new Error("send before transport");
      return new Uint8Array(tx!.encrypt(Buffer.from(plaintext)));
    },
  };
}
