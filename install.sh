#!/bin/sh
# PocketShell one-line installer
#   curl -fsSL https://raw.githubusercontent.com/Big-Pony/pocketshell/main/install.sh | sh
#   VERSION=1.5.0 curl -fsSL .../install.sh | sh     # pin a version
#
# This only puts the binary in place (download -> verify SHA256 -> extract).
# Turning it into a boot service is the next step, `pocketshell-agent install`,
# which needs an --advertise value we cannot ask for from a piped context — so
# we just print the command instead.
set -eu

REPO="${REPO:-Big-Pony/pocketshell}"
VERSION="${VERSION:-latest}"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

for c in curl tar; do
  command -v "$c" >/dev/null 2>&1 || die "missing command: $c"
done
if command -v sha256sum >/dev/null 2>&1; then SHACMD="sha256sum"
elif command -v shasum >/dev/null 2>&1; then SHACMD="shasum -a 256"
else die "neither sha256sum nor shasum found; cannot verify the download"
fi

# --- platform detection ------------------------------------------------------
os="$(uname -s)"; arch="$(uname -m)"
case "$os" in
  Linux)  os_part="linux" ;;
  Darwin) os_part="darwin" ;;
  *) die "unsupported OS: $os (Linux and macOS only)" ;;
esac
case "$arch" in
  x86_64|amd64) arch_part="x64" ;;
  aarch64|arm64) arch_part="arm64" ;;
  *) die "unsupported architecture: $arch (x86_64 and arm64 only)" ;;
esac
TARGET="${os_part}-${arch_part}"

# --- version -----------------------------------------------------------------
if [ "$VERSION" = "latest" ]; then
  TAG="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | sed -n 's/.*"tag_name" *: *"\([^"]*\)".*/\1/p' | head -1)"
  [ -n "$TAG" ] || die "could not fetch the latest version (network issue? pin one with VERSION=1.5.1)"
else
  case "$VERSION" in v*) TAG="$VERSION" ;; *) TAG="v$VERSION" ;; esac
fi
BASE="https://github.com/${REPO}/releases/download/${TAG}"
BIN_NAME="pocketshell-agent-${TARGET}"

# --- install dir --------------------------------------------------------------
# On macOS always install into the user dir — a LaunchAgent is user-domain, so keep the two consistent.
if [ "$os_part" = "darwin" ]; then
  BIN_DIR="$HOME/.local/bin"
elif [ "$(id -u)" = "0" ]; then
  BIN_DIR="/usr/local/bin"
else
  BIN_DIR="$HOME/.local/bin"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM

say "Downloading PocketShell ${TAG} (${TARGET})…"
curl -fsSL -o "$TMP/${BIN_NAME}.tar.gz" "${BASE}/${BIN_NAME}.tar.gz" \
  || die "download failed: ${BASE}/${BIN_NAME}.tar.gz"
curl -fsSL -o "$TMP/SHA256SUMS.txt" "${BASE}/SHA256SUMS.txt" \
  || die "failed to download the checksum file"

say "Verifying SHA256…"
# SHA256SUMS.txt holds "<hash>  ./<name>.tar.gz" (release.sh generates it inside dist/)
expected="$(sed -n "s|^\([0-9a-f]\{64\}\)  \./${BIN_NAME}\.tar\.gz$|\1|p" "$TMP/SHA256SUMS.txt" | head -1)"
[ -n "$expected" ] || die "no entry for ${BIN_NAME}.tar.gz in SHA256SUMS.txt"
actual="$($SHACMD "$TMP/${BIN_NAME}.tar.gz" | cut -d' ' -f1)"
[ "$expected" = "$actual" ] || die "SHA256 mismatch (expected $expected, got $actual) — aborted, nothing installed"

say "Extracting and installing into ${BIN_DIR}…"
tar -xzf "$TMP/${BIN_NAME}.tar.gz" -C "$TMP"
[ -f "$TMP/${BIN_NAME}" ] || die "${BIN_NAME} not found inside the archive"
mkdir -p "$BIN_DIR"
# The target may be running: remove before writing, so we never clobber a file being executed.
rm -f "$BIN_DIR/pocketshell-agent"
cp "$TMP/${BIN_NAME}" "$BIN_DIR/pocketshell-agent"
chmod 755 "$BIN_DIR/pocketshell-agent"

installed_version="$("$BIN_DIR/pocketshell-agent" --version 2>/dev/null || echo "?")"
say ""
say "✓ Installed pocketshell-agent ${installed_version} -> ${BIN_DIR}/pocketshell-agent"
say ""
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "Note: ${BIN_DIR} is not on your PATH — use the full path below, or add it to PATH first."; say "" ;;
esac
say "Next, install it as a service that starts on boot:"
if [ "$os_part" = "darwin" ]; then
  say "    pocketshell-agent install --advertise wss://your.domain --name my-mac"
else
  say "    sudo pocketshell-agent install --advertise wss://your.domain --name my-server"
fi
say ""
say "No domain? Use a placeholder, then let PocketShell get you a public HTTPS address:"
if [ "$os_part" = "darwin" ]; then
  say "    pocketshell-agent install --advertise ws://127.0.0.1:8722 --name my-mac"
  say "    pocketshell-agent tunnel setup"
else
  say "    sudo pocketshell-agent install --advertise ws://127.0.0.1:8722 --name my-server"
  say "    sudo pocketshell-agent tunnel setup"
fi
say ""
say "Other ways to expose it: https://github.com/${REPO}/blob/main/DEPLOYMENT.md"
