// 两侧 binframe 的**行为**一致性。
//
// 放在 app 侧、直接 import 两个实现：agent 是 Bun 项目但 binframe.ts 只用了
// TextEncoder/TextDecoder/Uint8Array 这些两端都有的东西，vitest（Node 22）
// 能直接跑 agent 的源文件。
//
// 为什么不用 protocol.mirror.test.ts 那套结构比较器：那个比的是**类型声明的
// 形状**，对纯类型文件够用；binframe.ts 是真逻辑，两侧结构一致而字节序不同
// 照样能通过——那会是一条永远绿的测试。这里比的是**实际产出的字节**。
import { test, expect } from "vitest";
import { packBinFrame as packApp, unpackBinFrame as unpackApp } from "./binframe";
import { packBinFrame as packAgent, unpackBinFrame as unpackAgent } from "../../../../agent/src/binframe";

// 共享向量：覆盖非法 UTF-8、空 blob、CJK 头、大头部。
const VECTORS: { header: object; blob: Uint8Array }[] = [
  { header: { type: "rpcZip", id: "1" }, blob: new Uint8Array([0xed, 0xa0, 0x80, 0xff, 0xfe]) },
  { header: { type: "rpcBin", id: "abc", result: { eof: true, size: 4096 } }, blob: new Uint8Array(0) },
  { header: { type: "rpc", id: "9", method: "fs.write", params: { path: "/中文/路径.txt", first: true } }, blob: new Uint8Array([0x00, 0x7b, 0x80]) },
  { header: { type: "rpcChunk", id: "x", index: 3, total: 7, enc: "gzip" }, blob: new Uint8Array(1024).fill(0xab) },
];

test("两侧 pack 产出逐字节相同的帧", () => {
  for (const v of VECTORS) {
    expect(Array.from(packApp(v.header, v.blob))).toEqual(Array.from(packAgent(v.header, v.blob)));
  }
});

test("两侧能解开对方产出的帧，内容逐字节相同", () => {
  for (const v of VECTORS) {
    const fromAgent = unpackApp(packAgent(v.header, v.blob));
    const fromApp = unpackAgent(packApp(v.header, v.blob));
    expect(fromAgent).not.toBeNull();
    expect(fromApp).not.toBeNull();
    expect(fromAgent!.header).toEqual(v.header);
    expect(fromApp!.header).toEqual(v.header);
    expect(Array.from(fromAgent!.blob)).toEqual(Array.from(v.blob));
    expect(Array.from(fromApp!.blob)).toEqual(Array.from(v.blob));
  }
});

test("两侧对坏帧的判定一致", () => {
  const bads = [
    new Uint8Array([0x00, 0x01]),
    new Uint8Array([0x00, 0xff, 0xff, 0x7b]),
    new Uint8Array([0x00, 0x00, 0x03, 0x7b, 0x7b, 0x7b]),
    new Uint8Array(Buffer.from('{"type":"pong"}', "utf8")),
  ];
  for (const b of bads) {
    expect(unpackApp(b)).toBeNull();
    expect(unpackAgent(b)).toBeNull();
  }
});
