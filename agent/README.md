# PocketShell Agent

在**你自己的机器**（有代码和 Claude Code 的那台）上跑一个二进制，手机浏览器访问它即可远程操作这台机器的终端。数据在手机 ↔ 你的机器之间端到端加密（Noise），不经过任何第三方服务器。

## 安装

从 Releases 下载对应平台的单文件二进制（无需安装 bun）：

- Linux x64 → `pocketshell-agent-linux-x64`
- Linux arm64 → `pocketshell-agent-linux-arm64`
- macOS (Apple Silicon) → `pocketshell-agent-darwin-arm64`
- macOS (Intel) → `pocketshell-agent-darwin-x64`
- Windows → 请在 **WSL2** 内使用 Linux x64 版

```bash
chmod +x pocketshell-agent-linux-x64
./pocketshell-agent-linux-x64
```

首次运行会打印：手机访问地址、可粘贴的**配对串**、Agent 公钥。缺 `tmux` 时会给出你系统对应的一行安装命令并退出——装好再跑即可。

## 让手机连上你（三选一）

Agent 监听的地址（bind）和对外公布给手机的地址（advertise）是解耦的。用 `POCKETSHELL_ADVERTISE` 告诉手机走哪个地址。

### 1) 公网 VPS（最常见）—— 前挂 Caddy 反代 wss

Agent 只监听本地，TLS 交给 Caddy（自动签证书）：

```bash
POCKETSHELL_HOST=127.0.0.1 POCKETSHELL_PORT=8722 \
POCKETSHELL_ADVERTISE=wss://你的域名 POCKETSHELL_TLS=0 \
./pocketshell-agent-linux-x64
```

`/etc/caddy/Caddyfile` 加一段（Caddy v2 默认支持 WebSocket、自动 HTTPS）：

```
你的域名 {
    reverse_proxy 127.0.0.1:8722
}
```

`sudo systemctl reload caddy`，手机浏览器打开 `https://你的域名` 即为 App。

> nginx 备选：`location / { proxy_pass http://127.0.0.1:8722; proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; }`（另需自备 TLS）。

### 2) 家里 / NAT 后的机器 —— Cloudflare Tunnel

用 `cloudflared` 给内网机器暴露一个公网 wss 域名，手机浏览器直连、最省事：

```bash
cloudflared tunnel --url http://127.0.0.1:8722
# 拿到 https://xxx.trycloudflare.com 后：
POCKETSHELL_ADVERTISE=wss://xxx.trycloudflare.com ./pocketshell-agent-linux-x64
```

### 3) 已在用 tailscale

手机也加入同一 tailnet，直接用机器的 tailscale IP：

```bash
POCKETSHELL_HOST=0.0.0.0 POCKETSHELL_PORT=8722 \
POCKETSHELL_ADVERTISE=ws://100.x.x.x:8722 ./pocketshell-agent-linux-x64
```

## 配对

手机打开 App 地址 → 进设置/设备管理 → 粘贴启动时打印的**配对串** → 连上。配对串含一次性配对码，请勿外传。

## 常驻运行（systemd）

`/etc/systemd/system/pocketshell.service`：

```ini
[Unit]
Description=PocketShell Agent
After=network.target

[Service]
ExecStart=/opt/pocketshell/pocketshell-agent-linux-x64
Environment=POCKETSHELL_HOST=127.0.0.1
Environment=POCKETSHELL_PORT=8722
Environment=POCKETSHELL_ADVERTISE=wss://你的域名
Environment=POCKETSHELL_TLS=0
Restart=on-failure
User=你的用户名

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now pocketshell
```

或手动挂在 tmux 里：`tmux new -s pocketshell './pocketshell-agent-linux-x64'`。

## 配置文件

首次运行会在 `~/.pocketshell/agent.json` 写出一份可编辑的**非敏感**配置（advertise/host/port/tls）。优先级：**环境变量 > agent.json > 默认值**。密钥单独存在 `~/.pocketshell/agent_key`（0600），绝不进 agent.json。
