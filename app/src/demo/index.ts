// 演示模式的唯一对外出口。App.svelte 只 import 这一个函数。
//
// 关键：DemoAgent 实例**全程只有一个**。Connection 每次重连都会调 wsFactory
// 拿新 socket，但 agent 不换——断线期间的状态与 replay 缓冲得以延续，这正是
// 「重连补齐」演示成立的前提。
import { Connection } from "../lib/net/connection";
import type { ClientMsg, ServerMsg } from "../lib/net/protocol";
import { DemoAgent } from "./agent";
import { DemoSocket } from "./socket";
import { identityChannel } from "./identity-channel";
import { DemoDirector } from "./script";

export function createDemoConnection(url: string): { conn: Connection; director: DemoDirector } {
  let socket: DemoSocket | null = null;
  let connectCount = 0;

  const agent = new DemoAgent({
    push: (msg: ServerMsg) => socket?.push(msg),
  });

  const conn = new Connection({
    url,
    channelFactory: identityChannel,
    wsFactory: () => {
      connectCount++;
      const s = new DemoSocket({
        onFrame: (m) => agent.handle(m as ClientMsg),
        // 第二次起才是重连——那时才延迟 open，让「重连中」看得见。
        isReconnect: connectCount > 1,
      });
      socket = s;
      // agent 的出口跟着换到新 socket；旧 socket 已 close，push 是 no-op。
      agent.setPush((msg) => s.push(msg));
      // 让调用方先挂上 onopen/onmessage 回调，再安排 open。
      queueMicrotask(() => s.start());
      return s;
    },
  });

  const director = new DemoDirector({
    agent,
    drop: () => {
      agent.detachTransport(); // 断线期间不再往外推，但内部计时器照跑
      conn.dropConnection();
    },
  });

  return { conn, director };
}
