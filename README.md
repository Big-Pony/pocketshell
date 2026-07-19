# PocketShell

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

**在手机上流畅运行终端 AI 编程 agent（Claude Code / Codex / opencode 等）的自托管移动终端。核心：断线续跑 + 重放——手机断网，服务端任务不停，重连后画面与状态自动补齐。**

*A self-hosted mobile terminal for running CLI/TUI coding agents (Claude Code, Codex, opencode, …) from your phone. Core feature: resilient sessions — your task keeps running server-side when the phone drops offline, and output is replayed on reconnect.*

[中文](#中文) · [English](#english)

<p align="center">
  <img src="assets/screenshots/1-键盘-全键盘.jpg" width="30%" alt="键盘界面 - 全键盘布局">
  <img src="assets/screenshots/2-键盘-输入法缓冲.jpg" width="30%" alt="键盘界面 - 输入法缓冲">
  <img src="assets/screenshots/3-键盘-快捷操作.jpg" width="30%" alt="键盘界面 - 快捷操作">
</p>

<p align="center">
  <img src="assets/screenshots/5-文件-菜单面板.jpg" width="30%" alt="文件管理 - 菜单面板">
  <img src="assets/screenshots/5-文件-目录.jpg" width="30%" alt="文件管理 - 目录浏览">
  <img src="assets/screenshots/5-文件-git.jpg" width="30%" alt="文件管理 - Git 版本控制">
</p>

<p align="center">
  <img src="assets/screenshots/4-任务.jpg" width="25%" alt="任务面板">
  <img src="assets/screenshots/6-指令.jpg" width="25%" alt="指令面板">
  <img src="assets/screenshots/7-设置.jpg" width="25%" alt="设置界面">
  <img src="assets/screenshots/8-浅色主题.jpg" width="25%" alt="浅色主题预览">
</p>

---

## 中文

### 简介

PocketShell 是一个**面向移动端的自托管远程终端**。它把开发机上的终端会话搬到手机浏览器里，让你随时随地用手机跑任意 **CLI/TUI 编程 agent**（Claude Code、Codex、opencode……）或普通 shell/vim/htop。

一个二进制 = 完整产品：内嵌前端、同端口 serve、端到端加密，别人在没装 Bun 的干净机器上下载即用。

**核心卖点 — 断线续跑 + 重放**：手机连开发机跑 agent，中途断网，服务端任务不停；重连后终端画面、滚动历史、会话状态自动补齐一致。

### 功能特性

- **多会话终端 / 服务端 tmux 面板**：列出机器上所有 tmux 会话（含非本 App 创建的），支持接管、重命名、终止；三态点（运行/等待/完成）+ 最后一行预览；每会话持久终端实例。
- **断线续跑 + 重放**：心跳双信号判离线、指数退避重连；按会话 `lastSeq` 记账，重连自动补发缺口，gap 时下发 resync；断线期间输出照常入 replay，任务不停。
- **端到端加密与设备安全**：每次连接做完整 Noise **IK** 握手（双向身份认证 + 前向保密）；信道内一次性配对码；设备注册表持久化，可命名 / 一键吊销（吊销即踢线）；固定窗口限速防爆破；结构化审计落盘。
- **自定义全键盘**：xterm 只读、输入统一经输入路由；完整笔记本布局（F1–F12 + 方向键 + 修饰键 sticky）；Fn 应用快捷层；系统输入法整段发送；键盘驱动选区/复制/粘贴；智能命令提示条（前缀联想、单击补全）。
- **快捷指令**：内置分组（常见 agent / Git / 项目命令）+ 自定义项，点击插入，多设备广播同步。
- **文件 + Git 面板**：惰性目录树 + 内联 git 标记；代码预览（高亮 + 行号），可切到编辑器编辑保存（CodeMirror 6，行号 / 搜索替换 / 系统输入法，分片保存 + 基于 mtime 的防误覆盖，新建文件直接进编辑器）；**文件预览：图片 / Markdown（渲染，含代码高亮与本地图片）/ 静态 HTML（sandbox iframe，可跑 JS + 相对资源），常驻头部栏 `预览｜源码｜编辑` + 刷新**；工作区 diff 可视化；只读 git log/分支/status；文件写操作（重命名/新建/删除强确认）；上传下载（多文件带进度、目录 zip、分片传输）。
- **移动外壳**：上下双区 + 可拖分割条（双击全屏）；底栏 5-tab；上区统一 tab 栏（终端 + 文件，可横向滚动）；打开状态持久化。
- **双主题**：深色 IDE / 浅色极简，设置里切换，即时生效。
- **中英双语**：全量 UI 走 i18n，首开跟随浏览器语言，设置里可切换。
- **PWA**：手机 Chrome 可「安装应用」，standalone 启动（零缓存 SW，永远拉最新）。
- **零依赖分发**：单文件二进制（`bun build --compile`，产 linux/darwin 多平台）；加密走纯 JS，无原生 addon；一台 Mac 可交叉编译出全平台。

> 对全屏 TUI agent 做了适配（如经典渲染器切换、alt-screen scrollback 归一），长输出可无上限滚动、输入行常驻底部。

### 快速开始

**环境要求**
- 开发机（运行 Agent 的一端）：`tmux`、`git`。
- 构建：[Bun](https://bun.sh) ≥ 1.3。

**方式一：源码运行（开发/自用）**

```bash
# 1) 后端 Agent（需 tmux）
cd agent && bun install && bun run start

# 2) 前端（另开终端）
cd app && bun install && bun run dev      # http://localhost:5173
```

**方式二：下载预编译二进制（最快，推荐）**

从 [Releases](https://github.com/Big-Pony/pocketshell/releases) 下载对应平台的压缩包（`linux-x64` / `linux-arm64` / `darwin-arm64` / `darwin-x64`），解压后运行：

```bash
# 以 Linux x64 为例，其余平台替换文件名即可
tar -xzf pocketshell-agent-linux-x64.tar.gz
./pocketshell-agent-linux-x64
```

可选：用同一 Release 附带的 `SHA256SUMS.txt` 校验完整性（`shasum -a 256 -c SHA256SUMS.txt`）。目标机只需 `tmux`。macOS 首次运行若被 Gatekeeper 拦截，在「系统设置 → 隐私与安全性」放行即可。

**方式三：从源码构建二进制**

```bash
# 先构建前端产物（Agent 会内嵌同端口 serve）
cd app && bun install && bun run build
# 再产出全平台单文件二进制
cd ../agent && bun install && bun run build:bin
```

把对应平台的二进制拷到目标机运行即可（目标机只需 `tmux`）。

**访问地址与默认端口**

Agent 默认监听 **`8722` 端口**（`POCKETSHELL_PORT` 可改），启动后在运行 Agent 的机器上用浏览器打开 `http://127.0.0.1:8722` 即可访问 App。注意默认只绑定 `127.0.0.1`——手机要从局域网/公网访问，需设置 `POCKETSHELL_HOST=0.0.0.0` 并配好 `POCKETSHELL_ADVERTISE`，或经反向代理暴露，具体见 [部署指南](./DEPLOYMENT.md)。

**首次配对**

Agent 首次运行会打印：App 访问地址、可粘贴的**配对串**、Agent 公钥。手机打开 App → 粘贴配对串完成一次性配对（默认 TTL 300s）。之后该设备即受信。

**常用环境变量**（`agent/src/config.ts`，优先级 env > `<keyDir>/agent.json` > 默认）

| 变量 | 默认 | 说明 |
|---|---|---|
| `POCKETSHELL_HOST` | `127.0.0.1` | 绑定地址 |
| `POCKETSHELL_PORT` | `8722` | 端口 |
| `POCKETSHELL_ADVERTISE` | — | 写进配对串的对外地址 |
| `POCKETSHELL_KEY_DIR` | `~/.pocketshell` | 密钥/设备/审计目录 |
| `POCKETSHELL_TLS` / `_CERT` / `_KEY` | `0` | Agent 内置 TLS（手供证书） |
| `POCKETSHELL_ADMIN` | 开启 | 本地管理页（仅 127.0.0.1），`0` 关闭 |

### 后台管理页

Agent 内置一个**仅限本机访问**的管理页：在运行 Agent 的机器上打开 `http://127.0.0.1:8722/admin`（端口随 `POCKETSHELL_PORT`，页面中英双语）。功能：

- **生成新配对码**：一键生成新的一次性配对串（TTL 300s），给新手机配对，无需重启 Agent；
- **查看已配对设备**：设备名、公钥、最近访问 IP、在线状态；
- **删除/吊销设备**：吊销后该设备立即断线，无法再握手。

管理页只响应来自 `127.0.0.1` 的请求，经反向代理或公网访问会被拒绝（有意设计，无需额外加固）；设 `POCKETSHELL_ADMIN=0` 可整体关闭。

### 部署

需要从公网访问（不在同一局域网）？见 **[部署指南 DEPLOYMENT.md](./DEPLOYMENT.md)**，涵盖四种方式：纯 IP+端口直连、服务器直接部署（Caddy / Nginx 反代）、Cloudflare Tunnel（无公网 IP）、frp 中转服务器，以及 systemd / launchd 常驻运行示例。

### 自动更新

Agent 内置基于 GitHub Releases 的应用内自动更新：启动、以及手机端每次连接时静默检查新版本（结果缓存 6 小时，检查失败不影响正常使用）。有新版本时 App 顶栏品牌旁出现更新徽标，点击打开确认弹窗，点「更新」即自动完成下载、校验、（macOS 上）重签名、替换二进制、重启，全程无需手动操作二进制文件。

- 用 `POCKETSHELL_UPDATE=0` 关闭该功能；`POCKETSHELL_UPDATE_REPO` 可改指向自己 fork 的仓库，设为 `off` 效果等同关闭。
- 应用内更新完成后的自重启依赖进程被 systemd / launchd 等 supervisor 托管；macOS 上首次授予的 Full Disk Access 权限在 OTA 后不会丢失。细节见 **[部署指南 § 自动更新（OTA）](./DEPLOYMENT.md#自动更新ota)**。

### 安全

端到端加密：每次连接做 Noise IK 握手，双向身份认证 + 前向保密，未登记设备握手就过不了；穿透/反代链路只是传输密文，解不开明文。**认证边界即安全边界**——过握手+配对的设备可浏览 Agent 进程权限内的文件（不做额外沙箱，请以进程权限约束访问面）。生产环境建议把 TLS 交给边缘（Cloudflare/Caddy）终结；加密密钥仅存于 `KEY_DIR`，从不入库。

### 性能

面向移动弱网优化：PTY 输出按时间/字节合批 + 按订阅定向 fan-out + 背压丢帧回落；大 RPC 响应自动分片重组；断线 gap-aware 补齐只补缺口；静态资源构建期预压缩（br/gz）+ ETag/304；隐藏终端停写、后台即 detach。

### 许可证

[Apache-2.0](./LICENSE)

---

## English

### Overview

PocketShell is a **self-hosted mobile-first remote terminal**. It brings your dev machine's terminal sessions into a phone browser, so you can run any **CLI/TUI coding agent** (Claude Code, Codex, opencode, …) or plain shell/vim/htop anywhere.

One binary = the whole product: the frontend is embedded and served on the same port, traffic is end-to-end encrypted, and it runs on a clean machine without Bun installed.

**Core feature — resilient sessions + replay:** run an agent from your phone, drop offline mid-task, and the server-side task keeps going; on reconnect the terminal screen, scrollback and session state are replayed back into sync.

### Features

- **Multi-session terminal / server-side tmux panel** — lists every tmux session on the host (even ones this app didn't create); attach, rename, kill; three-state dots (run/wait/done) + last-line preview; a persistent terminal per session.
- **Resilient sessions + replay** — dual-signal offline detection, exponential-backoff reconnect; per-session `lastSeq` accounting replays only the gap; output keeps flowing into replay while offline.
- **End-to-end encryption & device security** — full Noise **IK** handshake per connection (mutual auth + forward secrecy); one-time in-channel pairing code; persistent device registry with naming / one-click revoke; rate limiting; structured audit log.
- **Custom full keyboard** — read-only xterm, all input routed; full laptop layout (F1–F12, arrows, sticky modifiers); Fn app-command layer; IME whole-segment input; keyboard-driven selection/copy/paste; smart command-hint bar.
- **Snippets** — built-in groups (common agent / Git / project commands) plus custom ones, tap to insert, broadcast-synced across devices.
- **File + Git panel** — lazy tree with inline git markers; code preview (highlight + line numbers) that switches to an editor (CodeMirror 6 — line numbers, find/replace, native IME, chunked save with mtime-based overwrite guard, new files open straight into the editor); **file preview: images / Markdown (rendered, with code highlight + local images) / static HTML (sandboxed iframe that runs JS + relative assets), with a persistent `Preview｜Source｜Edit` header bar + refresh**; working-tree diff; read-only git log/branches/status; file ops (rename/new/delete with confirm); upload/download (multi-file with progress, dir-as-zip, chunked transfer).
- **Mobile shell** — split top/bottom panes with a draggable divider (double-tap fullscreen); 5-tab bottom bar; unified top tab bar (terminals + files); persisted layout.
- **Dual themes** — dark IDE / light minimal, switch in settings, applied instantly.
- **Bilingual** — full i18n (zh/en), follows browser language on first open, switchable in settings.
- **PWA** — installable on mobile Chrome, standalone launch (zero-cache SW, always latest).
- **Zero-dependency distribution** — single-file binary (`bun build --compile`, linux/darwin targets); pure-JS crypto, no native addons; cross-compile all targets from one Mac.

> Tuned for full-screen TUI agents (classic-renderer switch, alt-screen scrollback normalization) so long output scrolls without limit and the input line stays pinned to the bottom.

### Quick start

**Requirements**
- Host running the Agent: `tmux`, `git`.
- Build: [Bun](https://bun.sh) ≥ 1.3.

**Option A — run from source**

```bash
cd agent && bun install && bun run start     # backend (needs tmux)
cd app   && bun install && bun run dev        # frontend, http://localhost:5173
```

**Option B — download a prebuilt binary (fastest, recommended)**

Grab the archive for your platform (`linux-x64` / `linux-arm64` / `darwin-arm64` / `darwin-x64`) from [Releases](https://github.com/Big-Pony/pocketshell/releases), then extract and run:

```bash
# Linux x64 shown; swap the filename for other platforms
tar -xzf pocketshell-agent-linux-x64.tar.gz
./pocketshell-agent-linux-x64
```

Optional: verify integrity with the `SHA256SUMS.txt` shipped in the same Release (`shasum -a 256 -c SHA256SUMS.txt`). The target host only needs `tmux`. On macOS, if Gatekeeper blocks the first run, allow it under System Settings → Privacy & Security.

**Option C — build the binary from source**

```bash
cd app   && bun install && bun run build      # build embedded frontend first
cd agent && bun install && bun run build:bin  # single-file binaries, all platforms
```

Copy the binary for your platform to the target host (only `tmux` required) and run it.

**URL & default port**

The Agent listens on port **`8722`** by default (change with `POCKETSHELL_PORT`); once started, open `http://127.0.0.1:8722` in a browser on the host machine. Note it binds to `127.0.0.1` only by default — to reach it from your phone over LAN/internet, set `POCKETSHELL_HOST=0.0.0.0` plus `POCKETSHELL_ADVERTISE`, or put it behind a reverse proxy — see the [deployment guide](./DEPLOYMENT.md).

**First pairing**

On first run the Agent prints the App URL, a pasteable **pairing string**, and the Agent public key. Open the App on your phone, paste the pairing string to complete a one-time pairing (default TTL 300s). The device is trusted afterward.

**Common environment variables** (`agent/src/config.ts`; precedence env > `<keyDir>/agent.json` > default)

| Variable | Default | Purpose |
|---|---|---|
| `POCKETSHELL_HOST` | `127.0.0.1` | bind address |
| `POCKETSHELL_PORT` | `8722` | port |
| `POCKETSHELL_ADVERTISE` | — | external address baked into the pairing string |
| `POCKETSHELL_KEY_DIR` | `~/.pocketshell` | keys / devices / audit dir |
| `POCKETSHELL_TLS` / `_CERT` / `_KEY` | `0` | Agent built-in TLS (bring your own cert) |
| `POCKETSHELL_ADMIN` | on | local admin page (127.0.0.1 only), `0` to disable |

### Admin page

The Agent ships a built-in admin page restricted to **localhost only**: open `http://127.0.0.1:8722/admin` on the machine running the Agent (port follows `POCKETSHELL_PORT`; the page itself is bilingual zh/en). It lets you:

- **Generate a new pairing code** — a fresh one-time pairing string (TTL 300s) for pairing a new phone, no Agent restart needed;
- **Inspect paired devices** — name, public key, last-seen IP, online status;
- **Remove / revoke devices** — a revoked device is disconnected immediately and can no longer complete the handshake.

The admin page only answers requests from `127.0.0.1`; access via a reverse proxy or the public internet is rejected by design. Set `POCKETSHELL_ADMIN=0` to disable it entirely.

### Deployment

Need access from outside your LAN? See **[DEPLOYMENT.md](./DEPLOYMENT.md)** — it covers four setups: bare IP+port, direct server deployment behind Caddy / Nginx, Cloudflare Tunnel (no public IP needed), and an frp relay server, plus systemd / launchd service examples.

### Auto-update

The Agent has built-in in-app auto-update backed by GitHub Releases: it silently checks for a newer version on startup and again every time a phone connects (result cached 6h; a failed check never breaks normal use). When a newer version exists, an update badge appears next to the brand in the top bar; tap it to open a confirmation dialog, then tap "Update" — download, verify, (on macOS) re-sign, swap the binary, and restart all happen automatically, no manual binary handling required.

- Set `POCKETSHELL_UPDATE=0` to disable it; point `POCKETSHELL_UPDATE_REPO` at your own fork, or set it to `off` for the same effect as disabling.
- The self-restart after an in-app update relies on the process being supervisor-managed (systemd / launchd); on macOS, a Full Disk Access grant made before an update survives OTA. Details: **[DEPLOYMENT.md § Auto-update (OTA)](./DEPLOYMENT.md#auto-update-ota)**.

### Security

Every connection performs a Noise IK handshake with mutual authentication and forward secrecy; an unregistered device never gets past the handshake, and any tunnel/proxy in between only carries ciphertext. **The auth boundary is the security boundary** — a paired device can browse files within the Agent process's own permissions (no extra sandbox), so constrain access via process permissions. In production, terminate TLS at the edge (Cloudflare/Caddy). Crypto keys live only in `KEY_DIR` and are never committed.

### Performance

Tuned for flaky mobile networks: PTY output is batched by time/size and fanned out only to subscribers with backpressure drop/recover; large RPC responses are auto-chunked and reassembled; reconnect replays only the missing gap; static assets are precompressed (br/gz) with ETag/304; hidden terminals stop writing and background tabs detach.

### License

[Apache-2.0](./LICENSE)
