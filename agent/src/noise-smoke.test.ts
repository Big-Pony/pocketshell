import { test, expect } from "bun:test";
import Noise from "noise-handshake";
import Cipher from "noise-handshake/cipher";
import DH from "noise-handshake/dh";

const PRO = Buffer.from("pocketshell-v1");

test("noise-handshake IK: handshake + transport + authz readout", () => {
  const server = new Noise("IK", false);
  const client = new Noise("IK", true);
  client.initialise(PRO, server.s.publicKey);
  server.initialise(PRO);

  const m1 = client.send();
  server.recv(m1);
  // responder learns initiator static pubkey (used for authorizedKeys)
  expect(Buffer.compare(server.rs, client.s.publicKey)).toBe(0);

  const m2 = server.send();
  client.recv(m2);
  expect(client.complete && server.complete).toBe(true);

  const c2sSend = new Cipher(client.tx);
  const c2sRecv = new Cipher(server.rx);
  const enc = c2sSend.encrypt(Buffer.from("hello"));
  expect(Buffer.from(c2sRecv.decrypt(enc)).toString()).toBe("hello");
});

test("noise-handshake IK: tampered ciphertext throws", () => {
  const server = new Noise("IK", false);
  const client = new Noise("IK", true);
  client.initialise(PRO, server.s.publicKey);
  server.initialise(PRO);
  server.recv(client.send());
  client.recv(server.send());
  const send = new Cipher(client.tx);
  const recv = new Cipher(server.rx);
  const enc = send.encrypt(Buffer.from("x"));
  expect(() => recv.decrypt(Buffer.concat([enc, Buffer.from([0])]))).toThrow();
});

test("noise-handshake DH.generateKeyPair yields 32-byte persistable keypair", () => {
  const kp = DH.generateKeyPair();
  expect(kp.publicKey.length).toBe(32);
  expect(kp.secretKey.length).toBe(32);
  // reload path used by config.ts
  const reloaded = new Noise("IK", false, { publicKey: kp.publicKey, secretKey: kp.secretKey });
  expect(Buffer.compare(reloaded.s.publicKey, kp.publicKey)).toBe(0);
});
