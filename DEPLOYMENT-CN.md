# PocketShell 部署指南

[English](./DEPLOYMENT.md) · **中文**

---

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

### 通知与本地回环端点

Agent 内置一个仅本机可访问的通知回环端点 `/internal/notify`（`POST`，`127.0.0.1`-only + Bearer token 双重校验，任一不满足分别返回 403 / 401，请求体缺字段返回 400）。Claude Code / Codex / opencode 的 hook/notify 子进程在一轮任务完成或等待输入时会调用这个端点，触发应用内广播 + Web Push + Webhook 三路分发（功能介绍见 [README「通知」一节](./README-CN.md#通知)）。

每个终端会话启动时，Agent 会往子进程环境里注入三个变量供 hook 使用：

| 变量 | 说明 |
|---|---|
| `POCKETSHELL_NOTIFY_SESSION` | 当前会话 ID |
| `POCKETSHELL_NOTIFY_URL` | 回环端点地址，固定为 `http://127.0.0.1:<port>/internal/notify` |
| `POCKETSHELL_NOTIFY_TOKEN` | 鉴权 token，与 `<keyDir>/notify_token` 一致 |

**已知限制：开启内置 TLS 时通知触发不了。** `POCKETSHELL_NOTIFY_URL` 固定用明文 `http://` 回环；如果开启了内置 Agent TLS（`POCKETSHELL_TLS=1`，见方式 A 末尾），同一个监听端口只接受 TLS 握手，hook 子进程用明文 HTTP 连接会直接失败——这种组合下通知不会触发。生产环境默认 TLS 关闭、由边缘（Cloudflare/Caddy，方式 B/C/D）终结 TLS，不受此限制影响；只有在方式 A 上额外叠加内置自签 TLS 这一种配置会撞上。

`KEY_DIR`（默认 `~/.pocketshell`）新增几个通知相关落盘文件，均为 tmp+rename 原子写、权限 `0600`：

| 文件 | 内容 |
|---|---|
| `notify.json` | 通知总配置（工具开关 / Web Push 开关 / 摘要开关 / 去重窗口 / Webhook 列表，含各 Webhook 的 URL/secret） |
| `vapid.json` | Web Push 用的 VAPID 密钥对 |
| `push-subs.json` | 各设备的 Web Push 订阅信息 |
| `notify_token` | `/internal/notify` 鉴权用的随机 token |

### 命令行设备管理（无桌面运维）

`/admin` 管理页只监听 `127.0.0.1`，在纯 Linux / SSH 服务器上不方便打开。Agent 二进制内置了等效的命令行子命令，直接读写同一个 `POCKETSHELL_KEY_DIR`（务必用与常驻进程相同的 `POCKETSHELL_KEY_DIR` 环境变量运行）：

```bash
# 列出已配对设备（指纹、名称、加入时间、最近在线、最近 IP）
pocketshell-agent devices list

# 生成一个新的配对码并打印配对串；正在运行的 Agent 会自动采纳它，
# 无需重启即可让新手机配对（配对码 TTL 300 秒）
pocketshell-agent pair [--name <设备名>]

# 吊销某台设备（参数可用公钥全串，或列表里指纹的前缀）
pocketshell-agent devices remove <pubkey-or-fingerprint>
```

> `pair` 会把待配对码原子写入 `<keyDir>/pairing.pending.json`（0600）；常驻 Agent 在下一次有未授权设备尝试握手时读取并采纳它，配对成功后自动清盘。适合 Linux 无桌面场景，替代仅监听 localhost 的 `/admin` 页。

### 常见排查

| 现象 | 方向 |
|---|---|
| 手机打不开页面 | Agent 是否在跑；`HOST` 是否还是 `127.0.0.1`；反代/隧道进程是否存活 |
| 页面能开但连不上（一直重连） | 反代是否透传了 WebSocket（Nginx 检查 `Upgrade` 头）；HTTPS 页面必须走 `wss` |
| 配对总失败 | 配对码已过期（TTL 300s）——在 Agent 机器上开 `http://127.0.0.1:8722/admin` 重新生成 |
| launchd/systemd 下 Agent 反复退出 | 看错误日志；多半是 `PATH` 缺 tmux（macOS）或二进制无执行权限 |
| 终端里中文/图标乱码 | 确认目标机 locale；Agent 已用 `tmux -u` 强制 UTF-8，一般无需处理 |
