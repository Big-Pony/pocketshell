<div align="center">

# 📱 PocketShell

**Run Claude Code on your phone — drop offline, the task keeps running, output replays on reconnect**

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE) [![Release](https://img.shields.io/github/v/release/Big-Pony/pocketshell?color=success)](https://github.com/Big-Pony/pocketshell/releases) [![Stars](https://img.shields.io/github/stars/Big-Pony/pocketshell?logo=github)](https://github.com/Big-Pony/pocketshell/stargazers) ![Platforms](https://img.shields.io/badge/platform-linux%20%7C%20macOS-blue)

[Quick start](#-quick-start) • [Features](#-features) • [Deployment](#-deployment) • [Cheat sheet](./USAGE.md)

**Language**: English | [中文](./README-CN.md)

</div>

## 📸 Screenshots

<div align="center">

<table>
  <tr>
    <td align="center">
      <a href="assets/screenshots/01-launch-task.jpg"><img src="assets/screenshots/01-launch-task.jpg" alt="Compose a whole prompt in the IME buffer" width="200"/></a><br/>
      <sub>① Send the whole prompt</sub>
    </td>
    <td align="center">
      <a href="assets/screenshots/03-push-notification.jpg"><img src="assets/screenshots/03-push-notification.jpg" alt="Lock-screen push: Claude is waiting for your input" width="200"/></a><br/>
      <sub>② A push calls you back</sub>
    </td>
    <td align="center">
      <a href="assets/screenshots/04-task-done-git.jpg"><img src="assets/screenshots/04-task-done-git.jpg" alt="Task done, the Git panel shows the commit" width="200"/></a><br/>
      <sub>③ Output already replayed</sub>
    </td>
  </tr>
  <tr>
    <td align="center">
      <a href="assets/screenshots/06-task-panel.jpg"><img src="assets/screenshots/06-task-panel.jpg" alt="Task panel: several tmux sessions with three states" width="200"/></a><br/>
      <sub>④ Bottom pane: task panel</sub>
    </td>
    <td align="center">
      <a href="assets/screenshots/07-keyboard-full.jpg"><img src="assets/screenshots/07-keyboard-full.jpg" alt="Full keyboard — laptop layout" width="200"/></a><br/>
      <sub>⑤ Custom full keyboard</sub>
    </td>
    <td align="center">
      <a href="assets/screenshots/10-markdown-preview.jpg"><img src="assets/screenshots/10-markdown-preview.jpg" alt="Rendered Markdown preview" width="200"/></a><br/>
      <sub>⑥ File preview and Git</sub>
    </td>
  </tr>
</table>

<em>More screens in the <a href="./USAGE.md">interaction cheat sheet</a></em>

</div>

---

## 💡 What is this

PocketShell is a **self-hosted, mobile-first remote terminal**. It brings your dev machine's terminal sessions into a phone browser, so you can run any **CLI/TUI coding agent** (Claude Code, Codex, opencode, Kimi CLI, …) or plain shell/vim/htop from anywhere.

**The core feature is resilient sessions + replay**: run an agent from your phone, drop offline mid-task, and the server-side task keeps going; on reconnect the terminal screen, scrollback and session state are replayed back into sync. When the agent finishes or needs your input, it pushes a notification to your phone.

One binary = the whole product: the frontend is embedded and served on the same port, traffic is end-to-end encrypted, and it runs on a clean machine without Bun installed.

| | |
|---|---|
| ✅ **Good fit** | You have a Linux / macOS machine that stays on; you want to hand work to an AI while commuting, in bed, or in a queue; you care whether the task survives losing signal |
| ❌ **Not a fit** | You want a zero-config cloud service (this is self-hosted — you bring the machine and the domain); you want to write long code on a phone (it's a terminal, not an IDE); your host runs Windows (not supported yet) |

## ✨ Features

### 🖥 Terminal and sessions

- **Multi-session terminal** — lists every tmux session on the host (even ones this app didn't create); attach, rename, kill
- **Task panel** — three-state dots (running / waiting for input / background) plus a last-line preview per session
- **Resilient sessions** — dual-signal offline detection, exponential-backoff reconnect; the task keeps running server-side while you're gone
- **Precise replay** — per-session `lastSeq` accounting replays only the gap, never resending output you already have
- **TUI-tuned** — classic-renderer switch and alt-screen scrollback normalization, so long output scrolls without limit and the input line stays pinned to the bottom
- **Lightweight shell sessions** — an isolated raw PTY for one-off commands, kept out of the task panel

### ⌨ Phone input

- **Custom full keyboard** — a full laptop layout with F1–F12, arrows, and three-state sticky modifiers
- **IME whole-segment input** — compose the entire prompt with the system IME and inject it in one shot; the buffer survives disconnects
- **Smart command-hint bar** — prefix-based suggestions, tap to complete
- **Fn app-command layer** — switch tabs, scroll, create sessions, go fullscreen and rename, all from key combos
- **Quick actions panel** — D-pad layout with `Esc`/`Tab`/`Del`/`Home`/`End` and copy/paste on one screen
- **Snippets** — your own custom commands, tap to insert, broadcast-synced across devices

### 📁 Files, preview and Git

- **File tree** — lazy-loaded directory tree with inline git status markers (`M`/`A`/`D`/`?`)
- **Code editing** — CodeMirror 6 with line numbers, find/replace, native IME and line wrapping; chunked save with an mtime-based overwrite guard
- **File preview** — images / rendered Markdown / video (with a working seek bar) / static HTML (sandboxed iframe that runs JS and relative assets)
- **Git panel** — working-tree diff, read-only log / branches / status, one-tap branch refresh
- **Upload & download** — multi-file with progress, dir-as-zip, chunked transfer; the RPC deadline scales with queued bytes so slow links don't time out

### 🔔 Notifications and security

- **Push notifications** — get pinged the moment an agent finishes a round or waits for input, even with the app closed, the phone locked, or another session in view
- **Four supported tools** — Claude Code / Codex / opencode / Kimi CLI, each with its own switch in settings
- **Outbound webhooks** — built-in templates for WeCom / Feishu (optional signing) / Slack / Discord, plus a custom URL + JSON template
- **Smart do-not-disturb** — no system notification while you're watching that session; repeated completions within a short window collapse into one
- **End-to-end encryption** — a full Noise **IK** handshake per connection (mutual auth + forward secrecy); an unregistered device never gets past it
- **Device management** — one-time pairing codes, a persistent device registry, and one-command revocation (drops the connection and clears push subscriptions within seconds)

### 📱 App experience

- **Mobile shell** — split top/bottom panes with a draggable divider (double-tap fullscreen), a 5-tab bottom bar, persisted layout
- **Context usage** — while an AI is running, the split bar shows that session's context usage (e.g. `⊙ 142k/1M · 14%`)
- **Six themes** — four dark (Graphite Orange / Oscilloscope Cyan / Blackout Silver / Prussian Blue) plus two light (Warm White / Vermilion); can follow the system light/dark setting
- **Bilingual** — full i18n (zh/en), follows browser language on first open, switchable in settings
- **PWA** — installable to the home screen and launched standalone; static assets live in a per-version cache bucket that's dropped wholesale on a version change
- **Zero-dependency distribution** — a single-file binary, pure-JS crypto with no native addons, all targets cross-compiled from one Mac

> Mobile gestures and key combos are documented in the **[interaction cheat sheet (USAGE.md)](./USAGE.md)**.

## 🚀 Quick start

**Requirements**: the host running the Agent needs `tmux` and `git`.

**Step 1 — one-line install**

```bash
curl -fsSL https://raw.githubusercontent.com/Big-Pony/pocketshell/main/install.sh | sh
```

The script detects your platform, downloads the matching binary, verifies its SHA256 and installs it into `/usr/local/bin` (or `~/.local/bin`).

**Step 2 — turn it into a service that starts on boot**

```bash
# Linux
sudo pocketshell-agent install --advertise wss://your.domain --name my-server

# macOS — no sudo: a LaunchAgent lives in your user domain
pocketshell-agent install --advertise wss://your.domain --name my-mac
```

This writes the systemd/launchd service config → enables it at boot and starts it now → and **prints the pairing string right there on a first install**.

**Step 3 — pair your phone**

Open the URL in your phone's browser → paste the pairing string → name the device, done (the pairing string has a 300-second TTL). The device is trusted afterward, and you can "add to home screen" to use it as an app.

Once installed as a service that output goes to the log instead — read it with `sudo journalctl -u pocketshell -n 50` on Linux. If the code expires you don't need to restart: run `pocketshell-agent pair` and a running Agent picks up the fresh string automatically.

<details>
<summary><b>install subcommand options</b></summary>

`--advertise` is required: it decides which address goes into the pairing string, and without it your phone has nowhere to connect. The rest are optional:

| Flag | Default | Purpose |
|---|---|---|
| `--name` | — | an instance name, to tell several machines apart |
| `--user` | whoever invoked sudo | which user the service runs as |
| `--host` | `127.0.0.1` | bind address; use `0.0.0.0` for a phone connecting straight over the LAN |
| `--port` | `8722` | listening port |

To change a setting or move to a new version, just run the same command again: the old config is backed up first and **your key directory is left alone, so already-paired phones keep working** (which is also why a reinstall won't print a pairing string — run `pocketshell-agent pair` to add a new phone).

Pin a version with `VERSION=1.5.0 curl -fsSL … | sh`. To remove it: `pocketshell-agent uninstall` (stops the service and deletes the config, keeping your key directory and the binary).

</details>

<details>
<summary><b>Other install methods (from source / manual download / build it yourself)</b></summary>

**Run from source (development)**

```bash
# 1) backend Agent (needs tmux)
cd agent && bun install && bun run start

# 2) frontend (in another terminal)
cd app && bun install && bun run dev      # http://localhost:5173
```

**Download the binary manually**

Grab the archive for your platform (`linux-x64` / `linux-arm64` / `darwin-arm64` / `darwin-x64`) from [Releases](https://github.com/Big-Pony/pocketshell/releases), then extract and run:

```bash
tar -xzf pocketshell-agent-linux-x64.tar.gz
./pocketshell-agent-linux-x64
```

Optional: verify integrity with the `SHA256SUMS.txt` shipped in the same Release (`shasum -a 256 -c SHA256SUMS.txt`). The target host only needs `tmux`. On macOS, if Gatekeeper blocks the first run, allow it under System Settings → Privacy & Security.

> Run that way it's a **foreground process**: Ctrl+C or closing your SSH session stops it, and it won't come back after a reboot. For anything long-lived, use the `install` subcommand above, or wire it up by hand following [deployment guide § Running as a service](./DEPLOYMENT.md#running-as-a-service-systemd--launchd).

**Build the binary from source**

```bash
# build the embedded frontend first (the Agent serves it on the same port)
cd app && bun install && bun run build
# then produce single-file binaries for every platform
cd ../agent && bun install && bun run build:bin
```

Copy the binary for your platform to the target host (only `tmux` required) and run it. Building needs [Bun](https://bun.sh) ≥ 1.3.

</details>

<details>
<summary><b>URL, port and common environment variables</b></summary>

The Agent listens on port **`8722`** by default; once started, open `http://127.0.0.1:8722` in a browser on the host machine. Note it binds to `127.0.0.1` only by default — to reach it from your phone over LAN/internet, set `POCKETSHELL_HOST=0.0.0.0` plus `POCKETSHELL_ADVERTISE`, or put it behind a reverse proxy — see the [deployment guide](./DEPLOYMENT.md).

Precedence: env > `<keyDir>/agent.json` > default (see `agent/src/config.ts`).

| Variable | Default | Purpose |
|---|---|---|
| `POCKETSHELL_HOST` | `127.0.0.1` | bind address |
| `POCKETSHELL_PORT` | `8722` | port |
| `POCKETSHELL_ADVERTISE` | — | external address baked into the pairing string |
| `POCKETSHELL_KEY_DIR` | `~/.pocketshell` | keys / devices / audit dir |
| `POCKETSHELL_TLS` / `_CERT` / `_KEY` | `0` | Agent built-in TLS (bring your own cert) |
| `POCKETSHELL_UPDATE_REPO` | `Big-Pony/pocketshell` | release source for update checks |
| `POCKETSHELL_INSTANCE_NAME` | — | instance label, used to tell multiple installs apart |

**Running more than one server**: installing an Agent on several machines works out of the box — they know nothing about each other and share nothing (separate keys, sessions, push subscriptions). Give each one a `POCKETSHELL_INSTANCE_NAME` and it shows up under the home-screen icon, in the PWA's app name and in the app's top bar, so you get two independent PWAs you can tell apart at a glance — and **notifications from both servers reach you, neither displacing the other**. See the [deployment guide](./DEPLOYMENT.md).

</details>

## 🔒 Security

Every connection performs a Noise IK handshake with mutual authentication and forward secrecy; an unregistered device never gets past the handshake, and any tunnel/proxy in between only carries ciphertext. Crypto keys live only in `KEY_DIR` and are never committed.

**The auth boundary is the security boundary** — a paired device can browse files within the Agent process's own permissions (no extra sandbox), so constrain access via process permissions. In production, terminate TLS at the edge (Cloudflare / Caddy).

Device management is a command-line interface, run on the machine hosting the Agent:

```bash
pocketshell-agent pair [--name <device-name>]   # mint a pairing string (TTL 300s)
pocketshell-agent devices list                  # name, fingerprint, last seen, IP
pocketshell-agent devices remove <fingerprint>  # revoke a device (drops it within seconds)
```

> v1.8.0 removed the web admin page (it was reachable anonymously from the public internet on every reverse-proxied deployment). **If you ran a reverse-proxied deployment on v1.7.x or earlier**, check `<keyDir>/audit.log` for `admin_pair_new` events you did not trigger, and `devices list` for devices you do not recognise. Details in [deployment guide § CLI device management](./DEPLOYMENT.md#cli-device-management).

## 🔔 Notifications

When an agent (Claude Code / Codex / opencode / Kimi CLI) finishes a work round or is waiting on your input, it can push a notification to your phone — even if the app isn't open, the phone is locked, or you're looking at a different session.

Toggle it per tool under **Settings → Notifications**; the Agent idempotently writes one hook/notify entry into that tool's config (Claude Code → `~/.claude/settings.json`, Codex → `~/.codex/config.toml`, opencode → its plugin directory). Turning it off removes exactly that entry and leaves any other config you wrote by hand untouched.

Two delivery channels, both can be on:

- **Web Push** — needs to be opened from a PWA that's been added to the home screen, with notification permission granted. On iOS you must add it to the home screen first (a plain Safari tab can't receive push); on Android without Google Play Services, delivery may fail since it depends on reaching FCM.
- **Outbound webhooks** — built-in templates for WeCom / Feishu (optional signing secret) / Slack / Discord, plus a custom URL + JSON template; configure any number and test-send each one.

> **Privacy note**: notifications include an agent-output summary by default (you can turn that off). Web Push travels over the browser's standard encrypted channel, but **webhooks send the message in plaintext to third-party providers** — keep that in mind if the summary could contain sensitive output.

## 🌐 Deployment

Need access from outside your LAN? See **[DEPLOYMENT.md](./DEPLOYMENT.md)**, which covers four setups:

| Setup | When to use it |
|---|---|
| Bare IP + port | LAN-only access, no domain needed |
| Caddy / Nginx reverse proxy | A server with a public IP and a domain |
| Cloudflare Tunnel | Home connection with no public IP, no open ports |
| frp relay | No public IP, but you want to own the whole path |

The guide also includes systemd / launchd service examples and a troubleshooting table.

## 🔄 Auto-update

The Agent has built-in in-app auto-update backed by GitHub Releases: it silently checks on startup and each time a phone connects (result cached 6h; a failed check never breaks normal use). When a newer version exists, an update badge appears in the top bar; tap "Update" and download → SHA256 verification → (on macOS) re-signing → binary swap → restart all happen automatically.

- Set `POCKETSHELL_UPDATE=0` to disable it; `POCKETSHELL_UPDATE_REPO` can point at your own fork (checks still run, but the binary is no longer replaced automatically).
- The self-restart relies on the process being supervisor-managed (systemd / launchd); on macOS, a Full Disk Access grant made before an update survives OTA. Details in [deployment guide § Auto-update (OTA)](./DEPLOYMENT.md#auto-update-ota).

## 🛠 Tech stack

| Layer | Choice |
|---|---|
| Frontend | Svelte 5 (runes) + Vite 5 + [xterm.js](https://github.com/xtermjs/xterm.js) (WebGL renderer) + CodeMirror 6 + svelte-i18n |
| Backend | [Bun](https://bun.sh) + TypeScript, serving the embedded frontend and the WebSocket on one port |
| Sessions | tmux-managed PTYs — the session lives server-side, the app is just a screen onto it |
| Crypto | [noise-handshake](https://github.com/holepunchto/noise-handshake) Noise IK over pure-JS `sodium-javascript` (no native addons) |
| Storage | `bun:sqlite` (snippets) + atomically-written JSON (keys / devices / notification config) |
| Distribution | `bun build --compile` single-file binaries, cross-compiled for linux/darwin ×64/arm64 from one Mac |
| Testing | Vitest 2 + @testing-library/svelte (frontend) · Bun test (backend) · agent-browse MCP (e2e) |

## 📦 Version

Current release **v1.8.0** (2026-08-03) · full changelog in [Releases](https://github.com/Big-Pony/pocketshell/releases)

**v1.8.0** — removed the web admin page (it was anonymously reachable from the internet); device management is now CLI-only; `devices remove` takes effect on a running Agent; in-app updates install only from the official repository.

**v1.7.0** — AI context usage on the split bar (four tools); Kimi CLI push notifications; video preview with a working seek bar; a refresh button on the Git branch row.

**v1.6.0** — `install` / `uninstall` subcommands to set up a boot-start service in one command; one-line installer with SHA256 verification; fixed `pair` doing nothing for the first five minutes after service start.

## ⚡ Performance

Tuned for flaky mobile networks: PTY output is batched by time/size and fanned out only to subscribers with backpressure drop/recover; large RPC responses are auto-chunked and reassembled; reconnect replays only the missing gap; static assets are precompressed (br/gz) with ETag/304; hidden terminals stop writing and background tabs detach.

## 🤝 Contributing

Issues and pull requests are welcome.

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/your-feature`)
3. Commit your changes (`git commit -m 'feat: your feature'`)
4. Push the branch (`git push origin feat/your-feature`)
5. Open a Pull Request

Protocol changes start in the backend at `agent/src/protocol.ts`; `app/src/lib/protocol.ts` is its verbatim mirror. `bun test` and `bun run typecheck` must pass on both sides.

## 📄 License

[Apache-2.0](./LICENSE)

## 🙏 Acknowledgements

- [xterm.js](https://github.com/xtermjs/xterm.js) — terminal rendering in the browser
- [tmux](https://github.com/tmux/tmux) — the server-side session that makes drop-and-resume possible
- [Bun](https://bun.sh) — the runtime and single-file binary compiler
- [noise-handshake](https://github.com/holepunchto/noise-handshake) — the Noise IK implementation
- [CodeMirror](https://codemirror.net/) — a code editor that actually works on a phone

---

<div align="center">

**⭐ If this project helps you, please give it a Star!**

</div>
