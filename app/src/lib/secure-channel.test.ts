import { test, expect } from "vitest";
import Noise from "noise-handshake";
import Cipher from "noise-handshake/cipher";
import DH from "noise-handshake/dh";
import { createInitiatorChannel } from "./secure-channel";

const PRO = Buffer.from("pocketshell-v1");
const utf8 = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));
const str = (b: Uint8Array) => Buffer.from(b).toString("utf8");

function kp() {
  const k = DH.generateKeyPair();
  return { publicKey: new Uint8Array(k.publicKey), secretKey: new Uint8Array(k.secretKey) };
}

test("initiator drives IK against a raw responder and transports", () => {
  const serverId = kp();
  const clientId = kp();
  const server = new Noise("IK", false, { publicKey: Buffer.from(serverId.publicKey), secretKey: Buffer.from(serverId.secretKey) });
  server.initialise(PRO);

  const ch = createInitiatorChannel({ identity: clientId, agentPublicKey: serverId.publicKey });
  const m1 = ch.start();
  expect(m1).not.toBeNull();
  server.recv(Buffer.from(m1!));
  const m2 = server.send();
  const r = ch.receive(new Uint8Array(m2));
  expect(r.status).toBe("handshake");
  if (r.status !== "handshake") throw new Error();
  expect(r.established).toBe(true);
  expect(ch.state).toBe("transport");

  // client -> server
  const sRecv = new Cipher(server.rx);
  const enc = ch.send(utf8("ping"));
  expect(Buffer.from(sRecv.decrypt(Buffer.from(enc))).toString()).toBe("ping");
  // server -> client
  const sSend = new Cipher(server.tx);
  const dec = ch.receive(new Uint8Array(sSend.encrypt(Buffer.from("pong"))));
  expect(dec.status).toBe("message");
  if (dec.status !== "message") throw new Error();
  expect(str(dec.plaintext)).toBe("pong");
});
