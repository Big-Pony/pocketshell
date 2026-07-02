// A1 config — slice-1 minimal subset. Static keypair, device registry, audit,
// pairing TTL are added in later slices; fields are kept forward-compatible.
export interface AgentConfig {
  listen: { host: string; port: number };
  workspaceRoot: string;
  replayBufferBytes: number;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AgentConfig {
  return {
    listen: {
      host: env.POCKETSHELL_HOST ?? "0.0.0.0",
      port: env.POCKETSHELL_PORT ? Number(env.POCKETSHELL_PORT) : 8722,
    },
    workspaceRoot: env.POCKETSHELL_WORKSPACE ?? process.cwd(),
    replayBufferBytes: env.POCKETSHELL_REPLAY_BYTES
      ? Number(env.POCKETSHELL_REPLAY_BYTES)
      : 256 * 1024,
  };
}
