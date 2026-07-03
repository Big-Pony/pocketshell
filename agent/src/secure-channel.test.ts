import { test, expect } from "bun:test";
import Noise from "noise-handshake";
import Cipher from "noise-handshake/cipher";
import { createResponderChannel, type AuthDecision } from "./secure-channel";
import { toB64 } from "./bytes";
import DH from "noise-handshake/dh";

const PRO = Buffer.from("pocketshell-v1");
const utf8 = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));
const str = (b: Uint8Array) => Buffer.from(b).toString("utf8");

function serverIdentity() {
  const kp = DH.generateKeyPair();
  return { publicKey: new Uint8Array(kp.publicKey), secretKey: new Uint8Array(kp.secretKey) };
}

// A raw noise-handshake initiator standing in for the app side.
function rawClient(serverPub: Uint8Array) {
  const c = new Noise("IK", true);
  c.initialise(PRO, Buffer.from(serverPub));
  return c;
}

test("authorized handshake completes and transports both ways", () => {
  const id = serverIdentity();
  const client = rawClient(id.publicKey);
  const clientPubB64 = toB64(new Uint8Array(client.s.publicKey));
  const ch = createResponderChannel({ identity: id, authorize: (p) => p === clientPubB64 ? "authorized" : "reject" });

  expect(ch.start()).toBe(null);
  const m1 = client.send();
  const r = ch.receive(new Uint8Array(m1));
  expect(r.status).toBe("handshake");
  if (r.status !== "handshake") throw new Error();
  expect(r.established).toBe(true);
  expect(r.pending).toBeFalsy();
  expect(r.remoteStatic).toBe(clientPubB64);
  expect(r.reply).toBeDefined();
  client.recv(Buffer.from(r.reply!));
  expect(client.complete).toBe(true);
  expect(ch.state).toBe("transport");

  // client -> server
  const cSend = new Cipher(client.tx);
  const dec = ch.receive(new Uint8Array(cSend.encrypt(Buffer.from("ping"))));
  expect(dec.status).toBe("message");
  if (dec.status !== "message") throw new Error();
  expect(str(dec.plaintext)).toBe("ping");

  // server -> client
  const cRecv = new Cipher(client.rx);
  const enc = ch.send(utf8("pong"));
  expect(Buffer.from(cRecv.decrypt(Buffer.from(enc))).toString()).toBe("pong");
});

test("unauthorized client is rejected", () => {
  const id = serverIdentity();
  const client = rawClient(id.publicKey);
  const ch = createResponderChannel({ identity: id, authorize: () => "reject" });
  const r = ch.receive(new Uint8Array(client.send()));
  expect(r.status).toBe("fail");
  expect(ch.state).toBe("failed");
});

test("tampered transport frame -> fail", () => {
  const id = serverIdentity();
  const client = rawClient(id.publicKey);
  const ch = createResponderChannel({ identity: id, authorize: () => "authorized" });
  const r = ch.receive(new Uint8Array(client.send()));
  if (r.status !== "handshake") throw new Error();
  client.recv(Buffer.from(r.reply!));
  const cSend = new Cipher(client.tx);
  const enc = cSend.encrypt(Buffer.from("x"));
  const bad = new Uint8Array(Buffer.concat([Buffer.from(enc), Buffer.from([0])]));
  const dec = ch.receive(bad);
  expect(dec.status).toBe("fail");
  expect(ch.state).toBe("failed");
});

test("pending decision completes handshake but flags pending + remoteStatic", () => {
  const id = serverIdentity();
  const client = rawClient(id.publicKey);
  const clientPubB64 = toB64(new Uint8Array(client.s.publicKey));
  const ch = createResponderChannel({ identity: id, authorize: () => "pending" });
  const r = ch.receive(new Uint8Array(client.send()));
  expect(r.status).toBe("handshake");
  if (r.status !== "handshake") throw new Error();
  expect(r.established).toBe(true);
  expect(r.pending).toBe(true);
  expect(r.remoteStatic).toBe(clientPubB64);
  expect(ch.state).toBe("transport"); // encrypted channel usable, awaiting pair
});
