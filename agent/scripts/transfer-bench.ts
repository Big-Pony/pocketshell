// Verification: real agent + real Noise + real WS through a throttled relay,
// driving the REAL Connection (rpc/rpcBin deadline logic, acceptEnc negotiation,
// binary frames) — not a hand-rolled copy.
//
// 传输类问题**回环下复现不出**：本地 RTT≈0、带宽近乎无限，窗口深度与分片大小
// 的影响全被淹没。这个脚本在中间插一个限速 + 加延迟的 WS 中继，才能看见
// 「吞吐天花板 = 窗口深度 × 分片大小 ÷ RTT」。
//
// 用法（在 agent/ 下）：
//   bun run bench:transfer                                  # 默认 4×2.25MB 上传，150kbps/150ms
//   MODE=down MB_EACH=8 FILES=1 UP_KBPS=20000 RTT_MS=150 \
//     bun run bench:transfer                                # 高带宽+高RTT：隔离出 RTT 天花板
//
// **选参数要先想清楚在测什么**：把带宽压得很低（如 UP_KBPS=1000）时瓶颈是带宽，
// 窗口与分片的改动完全测不出差异。要验 RTT 天花板就得给足带宽、只留 RTT。
//
// 环境变量：FILES / MB_EACH / UP_KBPS / DOWN_KBPS（默认 UP 的 10 倍）/ RTT_MS /
//          MODE（up | down | both）。
//
// 十四期需求 3 修复记录（此前它跑不起来）：
//   1. import 路径失效 —— app 的网络层从 `app/src/lib/*` 搬到了 `app/src/lib/net/*`；
//   2. `noise-handshake` 在当时的所在目录（仓库根）解析不到——根目录没有
//      node_modules，依赖装在 app/ 与 agent/ 各自的 node_modules 里，所以显式
//      指到 app 的那一份；
//   3. **手写的 rpc() 已经无法驱动 uploadFiles** —— 二进制帧改造后上传走
//      conn.rpcBin，手写 shim 根本没有这个方法；而且它不发 acceptEnc，agent
//      会走 base64 回落，测出来的不是今天的真实链路。改为直接用真的
//      Connection：acceptEnc、features 协商、rpcBin、死线记账全都是线上那一套。
//   4. 中继自身有个假故障：每帧独立 setTimeout 会乱序投递 → Noise nonce 失序
//      → 随机 disconnected（8MB 约 50% 复现）。正解是「传输串行 + 传播并行但
//      保序」两段模型。**这不是被测代码的 bug，是测量工具的 bug**，排查传输
//      问题时别被它误导。
//
// 2026-08-11 从 `spike/upload-verify.ts` 迁来：它已不是一次性探针，而是传输层
// 唯一的回归工具（`spike/` 在 .gitignore 的 private 段里，留在那儿等于不存在）。
import { mkdtempSync, mkdirSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// agent/ 与 app/ 各自装依赖，noise-handshake 在 app 那份下面。
import DH from "../../app/node_modules/noise-handshake/dh";
import { toB64 } from "../src/bytes";
import { loadConfig } from "../src/config";
import { startServer } from "../src/server";
import { createInitiatorChannel } from "../../app/src/lib/net/secure-channel";
import { Connection, type WebSocketLike } from "../../app/src/lib/net/connection";

const FILES = Number(process.env.FILES ?? 4);
const MB_EACH = Number(process.env.MB_EACH ?? 2.25);
const UP_KBPS = Number(process.env.UP_KBPS ?? 150);
// 下行限速。不设时按 UP_KBPS 的 10 倍（家宽的典型不对称），设了就照设的来
// —— Task 4 的下载死线修复只有在下行明显受限时才验得出来。
const DOWN_KBPS = Number(process.env.DOWN_KBPS ?? UP_KBPS * 10);
const RTT_MS = Number(process.env.RTT_MS ?? 150);
// "up" | "down" | "both"
const MODE = process.env.MODE ?? "up";

const keyDir = mkdtempSync(join(tmpdir(), "ps-verify-"));
const destDir = mkdtempSync(join(tmpdir(), "ps-verify-dest-"));
mkdirSync(join(keyDir, "tmp"), { recursive: true });

const kp = DH.generateKeyPair();
const clientPub = new Uint8Array(kp.publicKey);
const clientSec = new Uint8Array(kp.secretKey);

const cfg = loadConfig({
  POCKETSHELL_KEY_DIR: keyDir,
  POCKETSHELL_AUTHORIZED_KEYS: toB64(clientPub),
  POCKETSHELL_PORT: "0", POCKETSHELL_HOST: "127.0.0.1", POCKETSHELL_UPDATE: "0",
});
const srv = startServer({ port: 0, config: cfg });
const agentPort = (srv as any).port;

const upBytesPerSec = (UP_KBPS * 1000) / 8;
const downBytesPerSec = (DOWN_KBPS * 1000) / 8;

/**
 * 单向限速管道：FIFO 队列 + 单个泵。
 *
 * **必须是队列，不能是"每帧各自 setTimeout(自己的到达时刻)"**。后者是这个脚本
 * 原本的写法，它会**乱序投递**：延迟是 `drainAt - now` 的浮点数，setTimeout 取
 * 整，两帧的 `now` 差 1ms 而 drainAt 只差 0.3ms 时，后发的那帧反而先到。而
 * Noise 的 ChaChaPoly 计数器**严格依赖到达顺序**——错一帧就 decrypt_failed，
 * SecureChannel 直接进 failed 态、连接被关掉，表现是随机的 `disconnected`
 * （8MB 下载约 50% 复现，1MB 从不复现，正是"帧越多越容易撞上"的形状）。
 * 排查这个假故障比它值得的时间多得多，别再改回去。
 */
function makePipe(bytesPerSec: number, deliver: (f: Uint8Array) => void) {
  // 两段模型，缺一不可：
  //   传输（带宽）—— **串行**：一条链路一次只推得动一帧，所以 drainAt 单调累加。
  //   传播（RTT） —— **并行**：已经上线的帧在路上同时飞，后一帧不必等前一帧
  //                  落地才起飞。把 RTT 也串起来会让窗口深度完全失效
  //                  （每帧固定摊一个 RTT/2，4 路并发与 16 路并发跑得一样慢），
  //                  那样测出来的就不是这次要测的东西了。
  // 投递用单个循环按 arriveAt 顺序放行，保证到达顺序 == 上线顺序（见下）。
  const outbox: { frame: Uint8Array; arriveAt: number }[] = [];
  let drainAt = Date.now();
  let delivering = false;
  const deliverLoop = () => {
    const head = outbox[0];
    if (head === undefined) { delivering = false; return; }
    const wait = head.arriveAt - Date.now();
    if (wait > 0) { setTimeout(deliverLoop, wait); return; }
    outbox.shift();
    try { deliver(head.frame); } catch { /* socket 已关 */ }
    deliverLoop();
  };
  return (frame: Uint8Array) => {
    const now = Date.now();
    drainAt = Math.max(now, drainAt) + (frame.byteLength / bytesPerSec) * 1000;
    // 到达时刻 = 上线完成时刻 + 半个 RTT（另外半个在反方向的管道上）。
    // drainAt 单调 ⇒ arriveAt 单调 ⇒ FIFO 投递即正确顺序。
    outbox.push({ frame, arriveAt: drainAt + RTT_MS / 2 });
    if (!delivering) { delivering = true; deliverLoop(); }
  };
}

const relay = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch(req, s) { if (s.upgrade(req)) return; return new Response("no"); },
  websocket: {
    open(ws) {
      const up = new WebSocket(`ws://127.0.0.1:${agentPort}`);
      up.binaryType = "arraybuffer";
      const q: Uint8Array[] = [];
      const pushUp = makePipe(upBytesPerSec, (f) => up.send(f));
      const pushDown = makePipe(downBytesPerSec, (f) => ws.send(f));
      (ws as any).data = { up, q, ready: false, pushUp, pushDown };
      up.onopen = () => { (ws as any).data.ready = true; for (const f of q.splice(0)) pushUp(f); };
      up.onmessage = (ev: MessageEvent) => pushDown(new Uint8Array(ev.data as ArrayBuffer));
      up.onclose = () => { try { ws.close(); } catch {} };
    },
    message(ws, raw) {
      const b = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer);
      const d = (ws as any).data;
      if (!d.ready) { d.q.push(b); return; } d.pushUp(b);
    },
    close(ws) { try { (ws as any).data.up.close(); } catch {} },
  },
});

console.log(`[verify] uplink=${UP_KBPS}kbps downlink=${DOWN_KBPS}kbps rtt=${RTT_MS}ms mode=${MODE}`);

// 真的 Connection：wsFactory 指向限速中继，channelFactory 用本进程生成的客户端
// 身份。心跳/活性放宽——限速链路上一次上传能占住链路很久，默认 25s 活性会在
// 传输中途误判掉线（真实 App 里同样存在这个张力，但那是另一个问题，别让它污染
// 这个基准）。
function wsFactory(url: string): WebSocketLike {
  const ws = new WebSocket(url) as unknown as WebSocketLike;
  ws.binaryType = "arraybuffer";
  return ws;
}

const conn = new Connection({
  url: `ws://127.0.0.1:${relay.port}`,
  wsFactory,
  channelFactory: () => createInitiatorChannel({
    identity: { publicKey: clientPub, secretKey: clientSec },
    agentPublicKey: new Uint8Array(cfg.identity.publicKey),
  }),
  getPairing: () => null,
  heartbeatMs: 15_000,
  livenessMs: 300_000,
});

// features（含 "bin"）随 agent 的第一条 sessions 消息到达，rpcBin 要等它。
let started = false;
conn.onSessions(() => { if (!started) { started = true; void main(); } });

// 每个文件用不同的确定性伪随机序列填满**每一个字节**（不是每 4096 个字节打
// 一个标记）——十四期加了多文件跨文件填充窗口，几个文件的分片在链路上交错
// 飞行，只对得上长度是查不出"内容串到别的文件里"的：稀疏标记下大段零字节
// 互相覆盖照样"看起来对"。逐字节哈希才是这条改动的守门。
function makeBuf(i: number, size: number): Uint8Array {
  const buf = new Uint8Array(size);
  let s = (0x9e3779b9 ^ (i * 0x85ebca6b)) >>> 0;
  for (let j = 0; j < size; j++) {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    buf[j] = s & 0xff;
  }
  return buf;
}

function sha256(bytes: Uint8Array): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(bytes);
  return h.digest("hex");
}

async function main() {
  const { uploadFiles, downloadFileBlob } = await import("../../app/src/lib/net/transfer");
  const items = Array.from({ length: FILES }, (_, i) => {
    const size = Math.round(MB_EACH * 1024 * 1024);
    const bytes = makeBuf(i, size);
    return { name: `f${i}.bin`, size, blob: new Blob([bytes]), destName: `f${i}.bin`, sha: sha256(bytes) };
  });
  const total = items.reduce((s, it) => s + it.size, 0);

  try {
    if (MODE === "up" || MODE === "both") {
      console.log(`[verify] uploading ${(total / 1024 / 1024).toFixed(2)} MB`);
      const t0 = Date.now();
      await uploadFiles(conn as never, destDir, items, {});
      const elapsed = Date.now() - t0;
      let allOk = true;
      for (const it of items) {
        const landed = new Uint8Array(readFileSync(join(destDir, it.destName)));
        if (landed.length !== it.size) {
          console.log(`[verify] ✗ ${it.destName}: ${landed.length} != ${it.size}`); allOk = false;
        } else if (sha256(landed) !== it.sha) {
          // 长度对但内容错 = 跨文件填充把别的文件的分片串进来了，或末尾
          // barrier 提交早了。这正是 Task 5 Step 2 的守门断言。
          console.log(`[verify] ✗ ${it.destName}: sha256 mismatch`); allOk = false;
        }
      }
      console.log(`[verify] UP ${allOk ? "✅ PASS" : "❌ CORRUPT"} in ${(elapsed / 1000).toFixed(1)}s ` +
        `(${(total / 1024 / 1024 / (elapsed / 1000)).toFixed(2)} MB/s)`);
    }

    if (MODE === "down" || MODE === "both") {
      // 下载方向：先把文件直接落到 destDir（不经链路），再走真实下载路径取回来，
      // 逐字节比对。MODE=up 已经上传过时复用那些文件。
      const srcFiles = items.map((it, i) => {
        const p = join(destDir, `dl${i}.bin`);
        if (!existsSyncSafe(p)) Bun.write(p, makeBuf(i, it.size));
        return { path: p, size: it.size, i };
      });
      // Bun.write 是异步的，等一拍确保落盘。
      await new Promise((r) => setTimeout(r, 200));
      const dlTotal = srcFiles.reduce((s, f) => s + f.size, 0);
      console.log(`[verify] downloading ${(dlTotal / 1024 / 1024).toFixed(2)} MB`);
      const t0 = Date.now();
      let allOk = true;
      for (const f of srcFiles) {
        const blob = await downloadFileBlob(conn as never, f.path);
        const got = new Uint8Array(await blob.arrayBuffer());
        const want = readFileSync(f.path);
        if (got.length !== want.length || !Buffer.from(got).equals(want)) {
          console.log(`[verify] ✗ download ${f.path}: ${got.length} vs ${want.length}`);
          allOk = false;
        }
      }
      const elapsed = Date.now() - t0;
      console.log(`[verify] DOWN ${allOk ? "✅ PASS" : "❌ CORRUPT"} in ${(elapsed / 1000).toFixed(1)}s ` +
        `(${(dlTotal / 1024 / 1024 / (elapsed / 1000)).toFixed(2)} MB/s)`);
    }
  } catch (e: any) {
    console.log(`[verify] ❌ FAILED: ${e?.code ?? ""} ${e?.message}`);
  }
  process.exit(0);
}

function existsSyncSafe(p: string): boolean {
  try { statSync(p); return true; } catch { return false; }
}

setTimeout(() => { console.log("[verify] !! global timeout"); process.exit(2); }, 900_000);
