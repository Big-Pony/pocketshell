import { test, expect } from "bun:test";
import { packBinFrame, unpackBinFrame, BIN_FRAME_MAGIC } from "./binframe";

// 非法 UTF-8 字节：孤立代理项 + 裸续字节 + 0xFF/0xFE。
// 这些字节经**任何** utf8 往返都会变成 U+FFFD，所以逐字节断言能立刻抓出
// 代码里残留的 toString("utf8") 往返。反过来要知道它的边界：base64 往返是
// 字节无损的，这组 fixture **抓不到**残留的 base64（只有尺寸断言能）。
const EVIL = new Uint8Array([0xed, 0xa0, 0x80, 0x80, 0xff, 0xfe, 0x41, 0x42, 0x00, 0x7b]);

test("往返：blob 逐字节相等（含非法 UTF-8）", () => {
  const frame = packBinFrame({ type: "rpcZip", id: "abc" }, EVIL);
  const r = unpackBinFrame(frame);
  expect(r).not.toBeNull();
  expect(r!.header).toEqual({ type: "rpcZip", id: "abc" });
  expect(Array.from(r!.blob)).toEqual(Array.from(EVIL));
});

test("首字节是魔数 0x00，第二三字节是头长大端", () => {
  const header = { type: "rpcBin", id: "x" };
  const headerLen = Buffer.byteLength(JSON.stringify(header), "utf8");
  const frame = packBinFrame(header, EVIL);
  expect(frame[0]).toBe(BIN_FRAME_MAGIC);
  expect((frame[1] << 8) | frame[2]).toBe(headerLen);
  expect(frame.length).toBe(3 + headerLen + EVIL.length);
});

test("空 blob 往返", () => {
  const r = unpackBinFrame(packBinFrame({ type: "rpcBin", id: "x" }, new Uint8Array(0)));
  expect(r).not.toBeNull();
  expect(r!.blob.length).toBe(0);
});

test("CJK 头往返（头长按 UTF-8 字节算，不是字符数）", () => {
  const header = { type: "rpc", id: "1", method: "fs.write", params: { path: "/中文/路径.txt" } };
  const r = unpackBinFrame(packBinFrame(header, EVIL));
  expect(r!.header).toEqual(header);
  expect(Array.from(r!.blob)).toEqual(Array.from(EVIL));
});

test("输入本身是 byteOffset>0 的视图时也正确", () => {
  // 真实场景：解密出的明文常常是某个更大 buffer 上的视图。
  const backing = new Uint8Array(200);
  const frame = packBinFrame({ type: "rpcZip", id: "v" }, EVIL);
  backing.set(frame, 37);
  const view = backing.subarray(37, 37 + frame.length);
  const r = unpackBinFrame(view);
  expect(Array.from(r!.blob)).toEqual(Array.from(EVIL));
});

test("坏帧一律返回 null，绝不抛异常", () => {
  // 调用点在 onmessage，那里没有 try/catch —— 抛异常会杀掉整帧处理。
  expect(unpackBinFrame(new Uint8Array([0x00, 0x01]))).toBeNull();          // 不足 3 字节
  expect(unpackBinFrame(new Uint8Array([0x00, 0xff, 0xff, 0x7b]))).toBeNull(); // 头长超出剩余字节
  const bad = new Uint8Array([0x00, 0x00, 0x03, 0x7b, 0x7b, 0x7b]);          // 头不是合法 JSON
  expect(unpackBinFrame(bad)).toBeNull();
});

test("非魔数开头返回 null（JSON 帧不该走到这里）", () => {
  expect(unpackBinFrame(new Uint8Array(Buffer.from('{"type":"pong"}', "utf8")))).toBeNull();
});

test("blob 是零拷贝视图（与整帧共享 buffer）—— 调用方据此决定是否 slice", () => {
  const frame = packBinFrame({ type: "rpcZip", id: "z" }, EVIL);
  const r = unpackBinFrame(frame)!;
  expect(r.blob.buffer).toBe(frame.buffer);
  expect(r.blob.byteOffset).toBeGreaterThan(0);
});

// 下面两条是专门为杀死两个特定 mutant 构造的 fixture——不是与上面「坏帧」用例
// 重复的覆盖。上面「坏帧」用例（不足 3 字节 / 头长超出剩余字节 / 头不是合法
// JSON / 非魔数开头）全都会在去掉对应检查后，落进 JSON.parse 抛异常那条
// 兜底路径，间接返回 null——这意味着删掉魔数判定或删掉越界判定，用现有那组
// fixture 跑测试**照样全绿**（mutation 验证已实测确认，见 task-A-report.md）。
// 这两条 fixture 刻意绕开了那条兜底：去掉对应检查后，代码会顺着
// subarray 的静默 clamp 一路解出一个**类型合法但语义错误**的 header，
// 而不是抛异常。

test("专门杀死「魔数检查被删」的 mutant——普通坏帧靠 JSON.parse 抛异常兜底，杀不到它", () => {
  // 首字节 0x7b 是合法 JSON 帧的开头（不是魔数 0x00），但紧跟的两字节
  // (0x00,0x02) 恰好是一个合法的小头长(2)，第 4-5 字节 "{}" 恰好是合法 JSON。
  // 完整实现：魔数不对，立即返回 null。
  // 删掉魔数检查后：headerLen=2、blobStart=5 恰好等于 bytes.length，边界检查
  // 也不拦，"{}" 解析成功——函数会返回 { header: {}, blob: [] }，不是 null。
  expect(unpackBinFrame(new Uint8Array([0x7b, 0x00, 0x02, 0x7b, 0x7d]))).toBeNull();
});

test("专门杀死「越界检查被删」的 mutant——普通坏帧靠 JSON.parse 抛异常兜底，杀不到它", () => {
  // 魔数对，但 headerLen 声称 255，帧里实际只有 2 字节可用（0x7b, 0x7d = "{}"）。
  // 完整实现：blobStart(258) 越界，立即返回 null。
  // 删掉越界检查后：bytes.subarray(3, 258) 被静默 clamp 成 subarray(3,5)="{}"，
  // JSON.parse 照样成功——函数会返回一个语义错误但类型合法的 header，不是 null。
  expect(unpackBinFrame(new Uint8Array([0x00, 0x00, 0xff, 0x7b, 0x7d]))).toBeNull();
});
