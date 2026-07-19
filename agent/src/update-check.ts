import { AGENT_VERSION } from "./version";
import { hasUpdate, assetNameForPlatform } from "./update-core";

export interface CheckResult {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  notes: string;
  publishedAt: string | null;
  canApply: boolean;
  reason?: string;
}

const CHECK_TIMEOUT_MS = 8000;

export async function checkLatest(opts: {
  repo: string | null;
  current?: string;
  fetchImpl?: typeof fetch;
  platform?: string;
  arch?: string;
}): Promise<CheckResult> {
  const current = opts.current ?? AGENT_VERSION;
  const base: CheckResult = { current, latest: null, hasUpdate: false, notes: "", publishedAt: null, canApply: false };

  if (!opts.repo) return { ...base, reason: "disabled" };

  const f = opts.fetchImpl ?? fetch;
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;

  let data: { tag_name?: string; body?: string; published_at?: string };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CHECK_TIMEOUT_MS);
    // process env proxies (HTTPS_PROXY/HTTP_PROXY/NO_PROXY) are honored by Bun's
    // fetch automatically, so China networks can route through a local proxy.
    const res = await f(`https://api.github.com/repos/${opts.repo}/releases/latest`, {
      headers: { "User-Agent": `pocketshell-agent/${current}`, Accept: "application/vnd.github+json" },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return { ...base, reason: "no_release_info" };
    data = await res.json();
  } catch {
    return { ...base, reason: "no_release_info" };
  }

  const tag = (data.tag_name ?? "").replace(/^v/, "");
  if (!tag) return { ...base, reason: "no_release_info" };
  const upd = hasUpdate(current, tag);
  const supported = assetNameForPlatform(platform, arch) !== null;
  const canApply = upd && supported;
  return {
    current,
    latest: tag,
    hasUpdate: upd,
    notes: data.body ?? "",
    publishedAt: data.published_at ?? null,
    canApply,
    reason: !supported ? "unsupported_platform" : undefined,
  };
}
