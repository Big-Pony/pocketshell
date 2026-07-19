# PocketShell 部署指南 / Deployment Guide

[中文](#中文) · [English](#english)

---

## 中文

本文介绍把 PocketShell Agent 暴露给手机访问的四种方式，按复杂度从低到高排列：

| 方式 | 适用场景 | 需要 |
|---|---|---|
| [A. 纯 IP + 端口](#方式-a纯-ip--端口无域名) | 局域网，或有公网 IP 但没有域名 | 无 |
| [B. 服务器直接部署 + 域名](#方式-b服务器直接部署--域名caddy--nginx) | Agent 跑在有公网 IP 的服务器上，有域名 | Caddy 或 Nginx |
| [C. Cloudflare Tunnel](#方式-ccloudflare-tunnel无公网-ip) | 家里/内网机器，无公网 IP | Cloudflare 账号 + 域名 |
| [D. frp 中转服务器](#方式-dfrp-中转服务器无公网-ip自控链路) | 无公网 IP，但有一台 VPS，想完全自控链路 | VPS + 域名 |

### 开始前：三个关键概念

**1. 监听地址与端口。** Agent 默认监听 `127.0.0.1:8722`，即只有本机能访问。两个环境变量控制：

- `POCKETSHELL_HOST` — 绑定地址。让局域网/隧道之外的设备直连时设为 `0.0.0.0`；走本机反代/隧道时保持 `127.0.0.1` 更安全。
- `POCKETSHELL_PORT` — 端口，默认 `8722`。

**2. 对外地址（`POCKETSHELL_ADVERTISE`）。** 首次运行打印的**配对串**里嵌着「手机应该连哪里」，这个地址由 `POCKETSHELL_ADVERTISE` 决定，格式是 WebSocket URL：直连写 `ws://<IP>:8722`，走 HTTPS 反代写 `wss://your.domain`。不设置时默认取 `ws://<HOST>:<PORT>`，绑定 `127.0.0.1` 或 `0.0.0.0` 时手机都连不上——**所有部署方式都应显式设置它**。

**3. 加密与 TLS 的关系。** PocketShell 自带端到端加密（每次连接做 Noise IK 握手，双向身份认证 + 前向保密）：终端内容在 WebSocket 帧内就是密文，**即使走明文 `http://` + `ws://` 链路，中间人也解不开、也冒充不了**。TLS/HTTPS 带来的是浏览器侧的额外好处：地址栏不告警、剪贴板等 API 不受限、可安装 PWA。因此纯 IP 直连（方式 A）是安全的，但体验最完整的是 HTTPS（方式 B/C/D）。

> 配对提示：配对码 TTL 300 秒且仅在进程启动时生成一次。Agent 长期常驻后要加新手机，不用重启——在 Agent 所在机器打开管理页 `http://127.0.0.1:8722/admin` 一键生成新配对串即可。

---

### 方式 A：纯 IP + 端口（无域名）

最简单：手机和 Agent 在同一局域网，或 Agent 所在机器有公网 IP。

```bash
POCKETSHELL_HOST=0.0.0.0 \
POCKETSHELL_ADVERTISE=ws://192.168.1.10:8722 \
./pocketshell-agent
```

手机浏览器打开 `http://192.168.1.10:8722`，粘贴配对串完成配对。

注意事项：

- 终端内容有 Noise 端到端加密，明文链路不泄密（见上文概念 3）；但 `http://` 源下浏览器会限制部分 API（剪贴板可能要手动授权、无法安装 PWA）。
- **公网 IP 直挂时建议收紧访问面**：用防火墙把端口限到自己的出口 IP，或改用方式 B/C/D。未配对设备虽然过不了握手，但没必要把端口敞给全网扫描。
- 想要 HTTPS 但不想装反代，可用 Agent 内置 TLS（自签证书）：

```bash
# 生成一次自签证书（默认路径 <keyDir>/tls_cert.pem + tls_key.pem）
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout ~/.pocketshell/tls_key.pem -out ~/.pocketshell/tls_cert.pem \
  -days 3650 -subj "/CN=pocketshell"

POCKETSHELL_HOST=0.0.0.0 POCKETSHELL_TLS=1 \
POCKETSHELL_ADVERTISE=wss://192.168.1.10:8722 \
./pocketshell-agent
```

自签证书浏览器会告警，需手动信任一次；介意的话用方式 B 拿真证书。

---

### 方式 B：服务器直接部署 + 域名（Caddy / Nginx）

Agent 跑在有公网 IP 的服务器上，域名已解析到该服务器。Agent 只监听本机，由反向代理终结 TLS：

```bash
POCKETSHELL_HOST=127.0.0.1 \
POCKETSHELL_ADVERTISE=wss://ps.example.com \
./pocketshell-agent
```

**Caddy（推荐，自动申请续期 HTTPS 证书，原生透传 WebSocket）** — `/etc/caddy/Caddyfile` 加一段即可：

```caddyfile
ps.example.com {
    reverse_proxy 127.0.0.1:8722
}
```

**Nginx** — WebSocket 需要显式升级头，且长连接超时要调大（终端可能长时间无输出）：

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

证书用 [certbot](https://certbot.eff.org/) 申请即可。配好后手机访问 `https://ps.example.com`。

---

### 方式 C：Cloudflare Tunnel（无公网 IP）

家里/办公室机器没有公网 IP 时，`cloudflared` 从内网主动外连 Cloudflare 建隧道，无需开放任何入站端口。前提：有 Cloudflare 账号且域名已托管在 Cloudflare。

```bash
# 1) 安装 cloudflared（Linux 见官方仓库，macOS：brew install cloudflared）
# 2) 登录并授权域名
cloudflared tunnel login

# 3) 创建隧道
cloudflared tunnel create pocketshell

# 4) 写配置 ~/.cloudflared/config.yml
#    tunnel / credentials-file 的值以 create 输出为准
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
# 5) 建 DNS 记录并跑起来
cloudflared tunnel route dns pocketshell ps.example.com
cloudflared tunnel run pocketshell        # 验证 OK 后可 cloudflared service install 常驻
```

Agent 侧保持本机监听：

```bash
POCKETSHELL_HOST=127.0.0.1 \
POCKETSHELL_ADVERTISE=wss://ps.example.com \
./pocketshell-agent
```

TLS 由 Cloudflare 边缘终结，WebSocket 直通；终端内容始终是 Noise 密文，Cloudflare 也解不开。也可以不写配置文件，直接在 Cloudflare Zero Trust 控制台（Networks → Tunnels）用网页向导完成同样的事。

---

### 方式 D：frp 中转服务器（无公网 IP，自控链路）

和方式 C 目标一样，但用自己的 VPS 做中转，链路完全自控（这也是作者自己的生产部署方式）。拓扑：

```
手机 → https://ps.example.com
     → VPS Caddy:443（TLS 终结） → 127.0.0.1:18092（frps 落地口）
     → frp 隧道（内网机 frpc 主动外连 VPS:7000）
     → 内网机 127.0.0.1:8722  pocketshell-agent
```

**VPS 侧** — `frps.toml`：

```toml
bindPort = 7000
auth.token = "换成你自己的长随机串"
# 落地端口只绑本机，公网无法直连 18092，只能经 Caddy 进来
proxyBindAddr = "127.0.0.1"
```

**VPS 侧** — Caddyfile 加一段：

```caddyfile
ps.example.com {
    reverse_proxy 127.0.0.1:18092
}
```

**内网机侧** — `frpc.toml`：

```toml
serverAddr = "你的VPS IP"
serverPort = 7000
auth.token = "与 frps 相同"

[[proxies]]
name = "pocketshell"
type = "tcp"
localIP = "127.0.0.1"
localPort = 8722
remotePort = 18092
```

**内网机侧** — Agent：

```bash
POCKETSHELL_HOST=127.0.0.1 \
POCKETSHELL_ADVERTISE=wss://ps.example.com \
./pocketshell-agent
```

配了 `proxyBindAddr = "127.0.0.1"` 后，frps 的 `18092` 落地口只绑在 VPS 本机、必须经 Caddy 转发才可达，公网只暴露 443（记得防火墙同时放行/限制 `7000` 仅供 frpc 连接）。可选再把域名套上 Cloudflare 代理（橙云），获得 CDN 与源站 IP 隐藏——WebSocket 会自动直通。

---

### 常驻运行（systemd / launchd）

**Linux（systemd）** — `/etc/systemd/system/pocketshell.service`：

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
journalctl -u pocketshell -f        # 看日志（含首次配对串）
```

**macOS（launchd）** — `~/Library/LaunchAgents/com.pocketshell.agent.plist`：

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
launchctl kickstart -k gui/$(id -u)/com.pocketshell.agent   # 重启
tail -f /tmp/pocketshell.out.log                            # 看日志（含首次配对串）
```

> ⚠️ launchd 环境的 `PATH` 极简，**必须**把 tmux 所在目录（Homebrew 为 `/opt/homebrew/bin`）加进 `EnvironmentVariables.PATH`，否则 Agent 启动时找不到 tmux 会直接退出。

### 自动更新（OTA）

Agent 启动时、以及手机端每次连接时，会静默向 GitHub Releases 查询是否有新版本（结果缓存 6 小时，查询失败不影响正常运行）。发现新版本后 App 顶栏品牌旁出现更新徽标，点击打开确认弹窗，点「更新」触发：下载对应平台压缩包 → 按 `SHA256SUMS.txt` 校验完整性 → （仅 macOS）用本机自签名身份重签名 → 原子替换正在运行的二进制 → 重启进程。

- **自重启的前提是进程被 supervisor 托管**：更新落地后 Agent 会尝试自我重启，若当前由 systemd（上文 `Restart=always`）或 launchd（上文 `KeepAlive`）管理，新二进制会被 supervisor 自动拉起；否则退化为「自己 spawn 一个分离子进程再退出」的兜底方式，稳定性不如受 supervisor 托管。**生产部署务必按上文配好 `Restart=always` / `KeepAlive`**，这样应用内更新才能可靠地重启为新版本。
- **开关与来源**：`POCKETSHELL_UPDATE=0` 整体关闭 OTA（不检查、不可更新）；`POCKETSHELL_UPDATE_REPO` 指定检查更新所用的 GitHub 仓库（默认 `Big-Pony/pocketshell`，设为 `off` 效果等同 `POCKETSHELL_UPDATE=0`，也可指向自己 fork 后的仓库）；检查请求走 `https://api.github.com/repos/<repo>/releases/latest`，遵循进程环境里的 `HTTPS_PROXY`/`HTTP_PROXY`。
- **macOS：首次 FDA 授权不会因 OTA 丢失。** 新二进制会用本机一份稳定的自签名身份（`PocketShell Self-Signed`）重新签名，签名的 Designated Requirement 不随每次构建变化，系统之前对旧二进制授予的 Full Disk Access 等 TCC 权限在更新后继续生效，不会被重新弹窗要求授权。这份签名身份需要**一次性、交互式**地建立（后台进程无法自动创建/信任证书）——运行 `pocketshell-agent --warmup` 完成；跳过这一步也不影响 OTA 正常更新，只是新二进制不会被签名，届时 TCC 权限可能需要重新授予。

### 常见排查

| 现象 | 方向 |
|---|---|
| 手机打不开页面 | Agent 是否在跑；`HOST` 是否还是 `127.0.0.1`；反代/隧道进程是否存活 |
| 页面能开但连不上（一直重连） | 反代是否透传了 WebSocket（Nginx 检查 `Upgrade` 头）；HTTPS 页面必须走 `wss` |
| 配对总失败 | 配对码已过期（TTL 300s）——在 Agent 机器上开 `http://127.0.0.1:8722/admin` 重新生成 |
| launchd/systemd 下 Agent 反复退出 | 看错误日志；多半是 `PATH` 缺 tmux（macOS）或二进制无执行权限 |
| 终端里中文/图标乱码 | 确认目标机 locale；Agent 已用 `tmux -u` 强制 UTF-8，一般无需处理 |

---

## English

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

### Troubleshooting

| Symptom | Where to look |
|---|---|
| Phone can't load the page | Is the Agent running? Is `HOST` still `127.0.0.1`? Is the proxy/tunnel process alive? |
| Page loads but keeps reconnecting | Does the proxy pass WebSocket through (check Nginx `Upgrade` headers)? HTTPS pages must use `wss` |
| Pairing always fails | Pairing code expired (300 s TTL) — open `http://127.0.0.1:8722/admin` on the Agent machine and mint a new one |
| Agent keeps exiting under launchd/systemd | Check error logs; usually `PATH` missing tmux (macOS) or a non-executable binary |
| Garbled CJK/icons in the terminal | Check the host locale; the Agent already forces UTF-8 via `tmux -u`, so this is rarely needed |
