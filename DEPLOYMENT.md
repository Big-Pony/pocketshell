# PocketShell Deployment Guide

**English** · [中文](./DEPLOYMENT-CN.md)

---

This guide covers four ways to expose the PocketShell Agent to your phone, from simplest to most involved:

| Option | When to use | Requires |
|---|---|---|
| [A. Bare IP + port](#option-a--bare-ip--port-no-domain) | Same LAN, or a public IP but no domain | nothing |
| [B. Direct server + domain](#option-b--direct-server-deployment-with-a-domain-caddy--nginx) | Agent runs on a server with a public IP and a domain | Caddy or Nginx |
| [C. Cloudflare Tunnel](#option-c--cloudflare-tunnel-no-public-ip) | Home/office machine without a public IP | Cloudflare account + domain |
| [D. frp relay server](#option-d--frp-relay-server-no-public-ip-self-controlled) | No public IP, but you own a VPS and want full control | VPS + domain |

### Before you start: three key concepts

**1. Bind address & port.** The Agent listens on `127.0.0.1:8722` by default — local access only. Two env vars control this:

- `POCKETSHELL_HOST` — bind address. Set `0.0.0.0` for direct access from other devices; keep `127.0.0.1` when a local reverse proxy / tunnel sits in front.
- `POCKETSHELL_PORT` — port, default `8722`.

**2. Advertised address (`POCKETSHELL_ADVERTISE`).** The **pairing string** printed on first run embeds "where the phone should connect", taken from `POCKETSHELL_ADVERTISE` as a WebSocket URL: `ws://<IP>:8722` for direct access, `wss://your.domain` behind an HTTPS proxy. If unset it defaults to `ws://<HOST>:<PORT>`, which is unreachable from a phone when bound to `127.0.0.1` or `0.0.0.0` — **set it explicitly in every deployment**.

**3. Encryption vs TLS.** PocketShell is end-to-end encrypted on its own (a Noise IK handshake per connection: mutual authentication + forward secrecy). Terminal traffic is ciphertext inside the WebSocket frames, so **even over plain `http://` + `ws://`, a man-in-the-middle can neither read nor impersonate anything**. What HTTPS adds is browser-side comfort: no address-bar warning, unrestricted clipboard APIs, and PWA installability. Bare-IP deployments (option A) are therefore safe; HTTPS setups (B/C/D) give the most complete experience.

> Pairing tip: the pairing code has a 300 s TTL and is only generated at process start. To pair a new phone on a long-running Agent, no restart is needed — open the admin page `http://127.0.0.1:8722/admin` on the Agent machine and mint a fresh pairing string.

---

### Option A — bare IP + port (no domain)

Simplest: phone and Agent share a LAN, or the Agent machine has a public IP.

```bash
POCKETSHELL_HOST=0.0.0.0 \
POCKETSHELL_ADVERTISE=ws://192.168.1.10:8722 \
./pocketshell-agent
```

Open `http://192.168.1.10:8722` on your phone and paste the pairing string.

Notes:

- Terminal traffic stays Noise-encrypted end-to-end (concept 3 above); however on an `http://` origin the browser restricts some APIs (clipboard may need manual permission, no PWA install).
- **On a public IP, narrow the attack surface**: firewall the port to your own egress IP, or use options B/C/D. Unpaired devices can't pass the handshake, but there's no reason to leave the port open to internet-wide scanning.
- Want HTTPS without a reverse proxy? Use the Agent's built-in TLS with a self-signed cert:

```bash
# generate once (default paths: <keyDir>/tls_cert.pem + tls_key.pem)
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout ~/.pocketshell/tls_key.pem -out ~/.pocketshell/tls_cert.pem \
  -days 3650 -subj "/CN=pocketshell"

POCKETSHELL_HOST=0.0.0.0 POCKETSHELL_TLS=1 \
POCKETSHELL_ADVERTISE=wss://192.168.1.10:8722 \
./pocketshell-agent
```

Browsers warn on self-signed certs (trust it once manually); use option B for a real certificate.

---

### Option B — direct server deployment with a domain (Caddy / Nginx)

The Agent runs on a server with a public IP; your domain points at it. Keep the Agent on localhost and let the reverse proxy terminate TLS:

```bash
POCKETSHELL_HOST=127.0.0.1 \
POCKETSHELL_ADVERTISE=wss://ps.example.com \
./pocketshell-agent
```

**Caddy (recommended — automatic HTTPS, WebSocket passthrough out of the box)** — add one block to `/etc/caddy/Caddyfile`:

```caddyfile
ps.example.com {
    reverse_proxy 127.0.0.1:8722
}
```

**Nginx** — WebSocket needs explicit upgrade headers, and long-lived idle connections need generous timeouts:

```nginx
server {
    listen 443 ssl;
    server_name ps.example.com;

    ssl_certificate     /etc/letsencrypt/live/ps.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ps.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8722;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }
}
```

Get certificates with [certbot](https://certbot.eff.org/). Then open `https://ps.example.com` on your phone.

---

### Option C — Cloudflare Tunnel (no public IP)

When the machine has no public IP, `cloudflared` dials out from inside your network to Cloudflare — no inbound ports at all. Prerequisites: a Cloudflare account with your domain on it.

```bash
# 1) install cloudflared (Linux: official repo; macOS: brew install cloudflared)
# 2) log in and authorize the domain
cloudflared tunnel login

# 3) create the tunnel
cloudflared tunnel create pocketshell

# 4) write ~/.cloudflared/config.yml
#    take tunnel / credentials-file values from the create output
```

```yaml
tunnel: <TUNNEL_ID>
credentials-file: /home/you/.cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: ps.example.com
    service: http://127.0.0.1:8722
  - service: http_status:404
```

```bash
# 5) create the DNS record and run
cloudflared tunnel route dns pocketshell ps.example.com
cloudflared tunnel run pocketshell        # then: cloudflared service install
```

Agent side stays on localhost:

```bash
POCKETSHELL_HOST=127.0.0.1 \
POCKETSHELL_ADVERTISE=wss://ps.example.com \
./pocketshell-agent
```

TLS terminates at Cloudflare's edge with WebSocket passthrough; terminal traffic remains Noise ciphertext that Cloudflare cannot read. Alternatively, skip the config file and use the web wizard in Cloudflare Zero Trust (Networks → Tunnels).

---

### Option D — frp relay server (no public IP, self-controlled)

Same goal as option C, but relayed through your own VPS so you control the whole path (this is the author's own production setup). Topology:

```
phone → https://ps.example.com
      → VPS Caddy:443 (TLS termination) → 127.0.0.1:18092 (frps landing port)
      → frp tunnel (frpc on the LAN machine dials out to VPS:7000)
      → LAN machine 127.0.0.1:8722  pocketshell-agent
```

**On the VPS** — `frps.toml`:

```toml
bindPort = 7000
auth.token = "replace-with-a-long-random-secret"
# bind landing ports to localhost only — 18092 is reachable through Caddy, not the internet
proxyBindAddr = "127.0.0.1"
```

**On the VPS** — add a Caddyfile block:

```caddyfile
ps.example.com {
    reverse_proxy 127.0.0.1:18092
}
```

**On the LAN machine** — `frpc.toml`:

```toml
serverAddr = "your.vps.ip"
serverPort = 7000
auth.token = "same-as-frps"

[[proxies]]
name = "pocketshell"
type = "tcp"
localIP = "127.0.0.1"
localPort = 8722
remotePort = 18092
```

**On the LAN machine** — the Agent:

```bash
POCKETSHELL_HOST=127.0.0.1 \
POCKETSHELL_ADVERTISE=wss://ps.example.com \
./pocketshell-agent
```

With `proxyBindAddr = "127.0.0.1"` set, the frps landing port `18092` binds to the VPS's localhost and is reachable only through Caddy; only 443 faces the internet (also firewall port `7000` so only your frpc can reach it). Optionally put Cloudflare's proxy (orange cloud) in front for CDN + origin-IP hiding — WebSocket passes through automatically.

---

### Running as a service (systemd / launchd)

**Linux (systemd)** — `/etc/systemd/system/pocketshell.service`:

```ini
[Unit]
Description=PocketShell Agent
After=network.target

[Service]
User=you
ExecStart=/usr/local/bin/pocketshell-agent
Environment=POCKETSHELL_HOST=127.0.0.1
Environment=POCKETSHELL_ADVERTISE=wss://ps.example.com
WorkingDirectory=/home/you
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pocketshell
journalctl -u pocketshell -f        # logs (incl. the first-run pairing string)
```

**macOS (launchd)** — `~/Library/LaunchAgents/com.pocketshell.agent.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.pocketshell.agent</string>
  <key>ProgramArguments</key>
  <array><string>/Users/you/.local/bin/pocketshell-agent</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <!-- PATH must include tmux's directory (Homebrew: /opt/homebrew/bin) -->
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>POCKETSHELL_HOST</key><string>127.0.0.1</string>
    <key>POCKETSHELL_ADVERTISE</key><string>wss://ps.example.com</string>
  </dict>
  <key>WorkingDirectory</key><string>/Users/you</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/pocketshell.out.log</string>
  <key>StandardErrorPath</key><string>/tmp/pocketshell.err.log</string>
</dict>
</plist>
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.pocketshell.agent.plist
launchctl kickstart -k gui/$(id -u)/com.pocketshell.agent   # restart
tail -f /tmp/pocketshell.out.log                            # logs (incl. pairing string)
```

> ⚠️ launchd starts with a minimal `PATH`. You **must** include tmux's directory (Homebrew: `/opt/homebrew/bin`) in `EnvironmentVariables.PATH`, otherwise the Agent exits at startup because it cannot find tmux.

### Auto-update (OTA)

On startup, and again each time a phone connects, the Agent silently checks GitHub Releases for a newer version (result cached 6h; a failed check never affects normal operation). When a newer version exists, an update badge appears next to the brand in the app's top bar; tapping it opens a confirmation dialog, and tapping "Update" triggers: download the platform's tar.gz → verify it against `SHA256SUMS.txt` → (macOS only) re-sign with a local self-signed identity → atomically swap the running binary → restart the process.

- **The self-restart requires the process to be supervisor-managed.** Once the swap lands, the Agent tries to restart itself; if it's under systemd (`Restart=always`, above) or launchd (`KeepAlive`, above), the supervisor relaunches the new binary automatically. Otherwise it falls back to spawning a detached replacement process and exiting — a less reliable path than supervisor management. **Production deployments should set `Restart=always` / `KeepAlive` as shown above** so in-app updates can reliably come back up as the new version.
- **Env vars:** `POCKETSHELL_UPDATE=0` disables OTA entirely (no checks, no updates). `POCKETSHELL_UPDATE_REPO` sets the GitHub repo checked for releases (default `Big-Pony/pocketshell`; `off` disables OTA the same as `POCKETSHELL_UPDATE=0`; can also point at your own fork). Checks hit `https://api.github.com/repos/<repo>/releases/latest` and honor `HTTPS_PROXY`/`HTTP_PROXY` from the process environment.
- **macOS: the first Full Disk Access grant survives OTA updates.** Each new binary is re-signed with a stable local self-signed identity (`PocketShell Self-Signed`), so its codesign designated requirement doesn't change between builds — TCC permissions (like Full Disk Access) granted to the previous binary carry over without a re-prompt. Provisioning that signing identity is a **one-time, interactive** step (a background process can't create/trust a certificate on its own) — run `pocketshell-agent --warmup` to set it up. Skipping this doesn't block OTA updates; the new binary just won't be signed, and TCC permissions may need to be re-granted.

### Notifications & the local loopback endpoint

The Agent has a built-in, localhost-only notification loopback endpoint, `/internal/notify` (`POST`, gated by both a `127.0.0.1`-only check and a Bearer token — either failing returns 403 / 401, and a missing required field returns 400). When Claude Code / Codex / opencode's hook/notify subprocess fires at the end of a work round or while waiting on input, it calls this endpoint, which fans out to in-app broadcast, Web Push, and webhooks (see [README's "Notifications" section](./README.md#notifications) for the feature overview).

Each terminal session gets three env vars injected into its subprocess environment for the hook to use:

| Variable | Purpose |
|---|---|
| `POCKETSHELL_NOTIFY_SESSION` | the current session ID |
| `POCKETSHELL_NOTIFY_URL` | the loopback endpoint, fixed at `http://127.0.0.1:<port>/internal/notify` |
| `POCKETSHELL_NOTIFY_TOKEN` | the auth token, matching `<keyDir>/notify_token` |

**Known limitation: notifications don't fire with built-in TLS enabled.** `POCKETSHELL_NOTIFY_URL` is fixed to plain `http://` loopback; if built-in Agent TLS is on (`POCKETSHELL_TLS=1`, see the end of option A), the same listening port only accepts TLS handshakes, so the hook subprocess's plain-HTTP connection fails outright — notifications simply won't trigger in that combination. Production deployments default to TLS off with the edge (Cloudflare/Caddy, options B/C/D) terminating TLS, so they're unaffected; this only bites the niche case of option A plus built-in self-signed TLS layered on top.

`KEY_DIR` (default `~/.pocketshell`) gains a few notification-related files on disk, all written atomically (tmp+rename) with `0600` permissions:

| File | Contents |
|---|---|
| `notify.json` | overall notification config (per-tool toggles / Web Push toggle / summary toggle / dedupe window / webhook list, including each webhook's URL/secret) |
| `vapid.json` | the VAPID key pair used for Web Push |
| `push-subs.json` | per-device Web Push subscriptions |
| `notify_token` | the random token used to authenticate calls to `/internal/notify` |

### CLI device management (headless ops)

The `/admin` page only listens on `127.0.0.1`, which is awkward to reach on a headless Linux / SSH server. The Agent binary ships equivalent CLI subcommands that read and write the same `POCKETSHELL_KEY_DIR` (run them with the same `POCKETSHELL_KEY_DIR` env var as the resident process):

```bash
# list paired devices (fingerprint, name, added time, last-seen, last IP)
pocketshell-agent devices list

# mint a new pairing code and print the pairing string; a running Agent
# adopts it automatically, so a new phone can pair with no restart
# (the pairing code has a 300 s TTL)
pocketshell-agent pair [--name <device-name>]

# revoke a device (pass the full public key, or a prefix of its fingerprint from the list)
pocketshell-agent devices remove <pubkey-or-fingerprint>
```

> `pair` atomically writes the pending code to `<keyDir>/pairing.pending.json` (0600); the resident Agent reads and adopts it the next time an unregistered device attempts the handshake, and clears it on a successful pairing. This suits headless Linux and replaces the localhost-only `/admin` page.

### Troubleshooting

| Symptom | Where to look |
|---|---|
| Phone can't load the page | Is the Agent running? Is `HOST` still `127.0.0.1`? Is the proxy/tunnel process alive? |
| Page loads but keeps reconnecting | Does the proxy pass WebSocket through (check Nginx `Upgrade` headers)? HTTPS pages must use `wss` |
| Pairing always fails | Pairing code expired (300 s TTL) — open `http://127.0.0.1:8722/admin` on the Agent machine and mint a new one |
| Agent keeps exiting under launchd/systemd | Check error logs; usually `PATH` missing tmux (macOS) or a non-executable binary |
| Garbled CJK/icons in the terminal | Check the host locale; the Agent already forces UTF-8 via `tmux -u`, so this is rarely needed |
