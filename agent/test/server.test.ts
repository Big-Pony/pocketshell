import { test, expect } from "bun:test";
import { startServer } from "../src/server";
import { encode, decodeServer } from "../src/protocol";
import { fromB64 } from "../src/bytes";

const hasTmux = Bun.spawnSync(["tmux", "-V"]).exitCode === 0;

test.skipIf(!hasTmux)("newSession + input round-trips output over WS", async () => {
  const srv = startServer({ port: 0 }); // ephemeral port
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}`);
  const outputs: string[] = [];

  await new Promise<void>((res) => (ws.onopen = () => res()));
  ws.onmessage = (ev) => {
    const msg = decodeServer(ev.data as string);
    if (msg.type === "output") {
      outputs.push(new TextDecoder().decode(fromB64(msg.data)));
    }
  };

  const NAME = "pocketshell_ws_test";
  ws.send(encode({ type: "newSession", name: NAME }));
  ws.send(encode({ type: "attach", sessionId: NAME }));
  await Bun.sleep(400);
  ws.send(encode({ type: "input", sessionId: NAME, data: btoa("echo WS_OK\n") }));
  await Bun.sleep(700);

  try {
    expect(outputs.join("")).toContain("WS_OK");
  } finally {
    ws.send(encode({ type: "kill", sessionId: NAME }));
    await Bun.sleep(100); // let the kill flush before tearing down
    ws.close();
    srv.stop();
  }
});
