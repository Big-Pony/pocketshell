#!/bin/sh
# PocketShell 一行安装脚本
#   curl -fsSL https://raw.githubusercontent.com/Big-Pony/pocketshell/main/install.sh | sh
#   VERSION=1.5.0 curl -fsSL .../install.sh | sh     # 指定版本
#
# 只负责把二进制放到位（下载 → 校验 SHA256 → 解压）。装成开机自启的服务是
# 下一步的 `pocketshell-agent install`，它需要 --advertise 参数，管道执行的
# 上下文里问不了，所以这里只打印命令。
set -eu

REPO="${REPO:-Big-Pony/pocketshell}"
VERSION="${VERSION:-latest}"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

for c in curl tar; do
  command -v "$c" >/dev/null 2>&1 || die "缺少命令：$c"
done
if command -v sha256sum >/dev/null 2>&1; then SHACMD="sha256sum"
elif command -v shasum >/dev/null 2>&1; then SHACMD="shasum -a 256"
else die "缺少 sha256sum 或 shasum，无法校验下载完整性"
fi

# --- 平台探测 ---------------------------------------------------------------
os="$(uname -s)"; arch="$(uname -m)"
case "$os" in
  Linux)  os_part="linux" ;;
  Darwin) os_part="darwin" ;;
  *) die "不支持的系统：$os（只支持 Linux 与 macOS）" ;;
esac
case "$arch" in
  x86_64|amd64) arch_part="x64" ;;
  aarch64|arm64) arch_part="arm64" ;;
  *) die "不支持的架构：$arch（只支持 x86_64 与 arm64）" ;;
esac
TARGET="${os_part}-${arch_part}"

# --- 版本 -------------------------------------------------------------------
if [ "$VERSION" = "latest" ]; then
  TAG="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | sed -n 's/.*"tag_name" *: *"\([^"]*\)".*/\1/p' | head -1)"
  [ -n "$TAG" ] || die "取不到最新版本号（网络问题？可用 VERSION=1.5.1 指定）"
else
  case "$VERSION" in v*) TAG="$VERSION" ;; *) TAG="v$VERSION" ;; esac
fi
BASE="https://github.com/${REPO}/releases/download/${TAG}"
BIN_NAME="pocketshell-agent-${TARGET}"

# --- 安装目录 ---------------------------------------------------------------
# macOS 一律装用户目录（LaunchAgent 是用户域的，二者保持一致）。
if [ "$os_part" = "darwin" ]; then
  BIN_DIR="$HOME/.local/bin"
elif [ "$(id -u)" = "0" ]; then
  BIN_DIR="/usr/local/bin"
else
  BIN_DIR="$HOME/.local/bin"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM

say "正在下载 PocketShell ${TAG}（${TARGET}）…"
curl -fsSL -o "$TMP/${BIN_NAME}.tar.gz" "${BASE}/${BIN_NAME}.tar.gz" \
  || die "下载失败：${BASE}/${BIN_NAME}.tar.gz"
curl -fsSL -o "$TMP/SHA256SUMS.txt" "${BASE}/SHA256SUMS.txt" \
  || die "下载校验文件失败"

say "校验 SHA256…"
# SHA256SUMS.txt 里是 "<hash>  ./<name>.tar.gz"（release.sh 在 dist 目录里生成）
expected="$(sed -n "s|^\([0-9a-f]\{64\}\)  \./${BIN_NAME}\.tar\.gz$|\1|p" "$TMP/SHA256SUMS.txt" | head -1)"
[ -n "$expected" ] || die "SHA256SUMS.txt 里没有 ${BIN_NAME}.tar.gz 的条目"
actual="$($SHACMD "$TMP/${BIN_NAME}.tar.gz" | cut -d' ' -f1)"
[ "$expected" = "$actual" ] || die "SHA256 校验失败（期望 $expected，实际 $actual）—— 已中止，不安装"

say "解压并安装到 ${BIN_DIR}…"
tar -xzf "$TMP/${BIN_NAME}.tar.gz" -C "$TMP"
[ -f "$TMP/${BIN_NAME}" ] || die "压缩包里没有 ${BIN_NAME}"
mkdir -p "$BIN_DIR"
# 目标可能正在运行：先删再放，避免写坏正在执行的文件。
rm -f "$BIN_DIR/pocketshell-agent"
cp "$TMP/${BIN_NAME}" "$BIN_DIR/pocketshell-agent"
chmod 755 "$BIN_DIR/pocketshell-agent"

installed_version="$("$BIN_DIR/pocketshell-agent" --version 2>/dev/null || echo "?")"
say ""
say "✓ 已安装 pocketshell-agent ${installed_version} → ${BIN_DIR}/pocketshell-agent"
say ""
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "注意：${BIN_DIR} 不在 PATH 里，下面的命令请用完整路径，或先把它加进 PATH。"; say "" ;;
esac
say "接下来装成开机自启的服务（把域名换成你自己的）："
if [ "$os_part" = "darwin" ]; then
  say "    pocketshell-agent install --advertise wss://your.domain --name 我的Mac"
else
  say "    sudo pocketshell-agent install --advertise wss://your.domain --name 我的服务器"
fi
say ""
say "还没配反向代理？见 https://github.com/${REPO}/blob/main/DEPLOYMENT-CN.md"
