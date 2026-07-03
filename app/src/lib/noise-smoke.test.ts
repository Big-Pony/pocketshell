import { test, expect } from "vitest";
import Noise from "noise-handshake";
import Cipher from "noise-handshake/cipher";

const PRO = new TextEncoder().encode("pocketshell-v1");

test("noise-handshake IK runs under vitest-jsdom", () => {
  const server = new Noise("IK", false);
  const client = new Noise("IK", true);
  client.initialise(PRO, server.s.publicKey);
  server.initialise(PRO);
  server.recv(client.send());
  client.recv(server.send());
  expect(client.complete && server.complete).toBe(true);

  const send = new Cipher(client.tx);
  const recv = new Cipher(server.rx);
  const enc = send.encrypt(Buffer.from("hi"));
  expect(Buffer.from(recv.decrypt(enc)).toString()).toBe("hi");
});
