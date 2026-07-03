// A3.5 SecureChannel (responder). Wraps noise-handshake IK: solves crypto so
// server.ts stays protocol-only. The initiator counterpart lives in the app.
// S4b: injectable authorize(pub)→authorized|pending|reject replaces hardcoded allowlist.
import Noise from "noise-handshake";
import Cipher from "noise-handshake/cipher";
import { toB64 } from "./bytes";

const PROLOGUE = Buffer.from("pocketshell-v1");

export type AuthDecision = "authorized" | "pending" | "reject";

export type RecvResult =
  | { status: "handshake"; reply?: Uint8Array; established?: boolean; remoteStatic?: string; pending?: boolean }
  | { status: "message"; plaintext: Uint8Array }
  | { status: "fail"; reason: string };

export interface SecureChannel {
  readonly state: "handshaking" | "transport" | "failed";
  start(): Uint8Array | null;
  receive(frame: Uint8Array): RecvResult;
  send(plaintext: Uint8Array): Uint8Array;
}

export function createResponderChannel(opts: {
  identity: { publicKey: Uint8Array; secretKey: Uint8Array };
  authorize: (clientPubB64: string) => AuthDecision;
}): SecureChannel {
  const hs = new Noise("IK", false, {
    publicKey: Buffer.from(opts.identity.publicKey),
    secretKey: Buffer.from(opts.identity.secretKey),
  });
  hs.initialise(PROLOGUE);
  let state: SecureChannel["state"] = "handshaking";
  let tx: Cipher | null = null;
  let rx: Cipher | null = null;

  return {
    get state() { return state; },
    start() { return null; }, // responder waits for msg1
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
        hs.recv(Buffer.from(frame));
      } catch {
        state = "failed";
        return { status: "fail", reason: "handshake_error" };
      }
      const clientPub = toB64(new Uint8Array(hs.rs));
      const decision = opts.authorize(clientPub);
      if (decision === "reject") {
        state = "failed";
        return { status: "fail", reason: "unauthorized" };
      }
      const reply = new Uint8Array(hs.send());
      tx = new Cipher(hs.tx);
      rx = new Cipher(hs.rx);
      state = "transport";
      return { status: "handshake", reply, established: true, remoteStatic: clientPub, pending: decision === "pending" };
    },
    send(plaintext) {
      if (state !== "transport") throw new Error("send before transport");
      return new Uint8Array(tx!.encrypt(Buffer.from(plaintext)));
    },
  };
}
