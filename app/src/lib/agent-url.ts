// Compute the default Agent WebSocket URL based on the page context.
// In dev (vite) the page is on :5173 but the agent listens on :8722.
// In production (agent-embedded or behind a reverse proxy) the page and
// WebSocket share the same host/port, and the scheme must match the page.
export function defaultAgentUrl(isDev: boolean, location: {
  protocol: string;
  host: string;
  hostname: string;
}): string {
  // Dev (vite): page and agent are on different ports; agent is always local ws.
  if (isDev) return `ws://${location.hostname}:8722`;
  // Production: page and agent share the same host/port (possibly behind a proxy).
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}`;
}
