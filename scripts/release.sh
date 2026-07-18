#!/usr/bin/env bash
# Cut a PocketShell release: cross-compile every target binary, package them as
# per-platform tarballs with a shared SHA256SUMS.txt, then bump the version,
# commit, tag, push, and publish a GitHub Release with the archives attached.
#
# Usage:
#   scripts/release.sh <version> [--dry-run] [--notes-file PATH]
#
#   scripts/release.sh 0.2.0 --dry-run
#       Build + package + checksum into agent/dist only. No version bump, no
#       commit/tag/push, no GitHub Release. Use it to verify the cross-compile
#       before publishing for real.
#
#   https_proxy=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890 \
#     scripts/release.sh 0.2.0 --notes-file docs/deploy-info/release-notes/v0.2.0.md
#       Full release. git push and gh honor $https_proxy / $HTTPS_PROXY — set
#       them when direct github.com access times out on this network.
#
# --notes-file  Markdown file used verbatim as the GitHub Release body. Without
#               it the release is created with --generate-notes (commit-derived).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT="$REPO/agent"
DIST="$AGENT/dist"
# Must match the targets build-bin.ts compiles and the platforms the README
# download section advertises.
TARGETS=(linux-x64 linux-arm64 darwin-arm64 darwin-x64)

# --- args --------------------------------------------------------------------
VERSION=""
DRY_RUN=0
NOTES_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --notes-file) NOTES_FILE="${2:-}"; shift ;;
    -*) echo "unknown flag: $1" >&2; exit 2 ;;
    *) if [ -z "$VERSION" ]; then VERSION="$1"; else echo "unexpected arg: $1" >&2; exit 2; fi ;;
  esac
  shift
done

[ -n "$VERSION" ] || { echo "usage: scripts/release.sh <version> [--dry-run] [--notes-file PATH]" >&2; exit 2; }
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "version must be semver like 0.2.0 (got: $VERSION)" >&2; exit 2; }
TAG="v$VERSION"

# --- preconditions -----------------------------------------------------------
for c in bun tar shasum git; do command -v "$c" >/dev/null || { echo "missing tool: $c" >&2; exit 1; }; done
if [ "$DRY_RUN" -eq 0 ]; then
  command -v gh >/dev/null || { echo "missing tool: gh" >&2; exit 1; }
  gh auth status >/dev/null 2>&1 || { echo "gh not authenticated (run: gh auth login)" >&2; exit 1; }
  [ -z "$(git -C "$REPO" status --porcelain)" ] || { echo "working tree not clean; commit or stash first" >&2; exit 1; }
  git -C "$REPO" rev-parse "$TAG" >/dev/null 2>&1 && { echo "tag $TAG already exists" >&2; exit 1; }
  [ -n "$NOTES_FILE" ] && [ ! -f "$NOTES_FILE" ] && { echo "notes file not found: $NOTES_FILE" >&2; exit 1; }
fi

echo "[release] version=$VERSION tag=$TAG dry_run=$DRY_RUN branch=$(git -C "$REPO" branch --show-current)"

# --- version bump (skipped on dry-run) --------------------------------------
if [ "$DRY_RUN" -eq 0 ]; then
  for pj in "$AGENT/package.json" "$REPO/app/package.json"; do
    sed -i.bak -E "s/\"version\": *\"[0-9]+\.[0-9]+\.[0-9]+\"/\"version\": \"$VERSION\"/" "$pj"
    rm -f "$pj.bak"
    echo "[release] set version=$VERSION in ${pj#"$REPO"/}"
  done
fi

# --- build all target binaries ----------------------------------------------
# build:bin: vite build -> gen:embedded -> compile each target into agent/dist
# -> sign darwin (if the identity exists) -> restore the committed manifest stub.
echo "[release] building binaries (bun run build:bin)…"
( cd "$AGENT" && bun run build:bin )

# --- package + checksums -----------------------------------------------------
rm -f "$DIST"/*.tar.gz "$DIST/SHA256SUMS.txt"
for plat in "${TARGETS[@]}"; do
  bin="pocketshell-agent-$plat"
  [ -f "$DIST/$bin" ] || { echo "missing built binary: $DIST/$bin" >&2; exit 1; }
  chmod +x "$DIST/$bin"
  # Archive carries the platform binary plus LICENSE (Apache-2.0 requires the
  # license to travel with the distribution). Extracts to `./$bin` per README.
  tar -czf "$DIST/$bin.tar.gz" -C "$DIST" "$bin" -C "$REPO" LICENSE
  echo "[release] packaged $bin.tar.gz ($(du -h "$DIST/$bin.tar.gz" | cut -f1))"
done
( cd "$DIST" && shasum -a 256 ./*.tar.gz > SHA256SUMS.txt )
echo "[release] SHA256SUMS.txt:"
sed 's/^/    /' "$DIST/SHA256SUMS.txt"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "[release] --dry-run complete. artifacts in $DIST (no git/gh changes made)."
  exit 0
fi

# --- commit, tag, push -------------------------------------------------------
git -C "$REPO" add "$AGENT/package.json" "$REPO/app/package.json"
git -C "$REPO" commit \
  -m "release: $TAG — bump version to $VERSION" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git -C "$REPO" tag -a "$TAG" -m "PocketShell $TAG"
echo "[release] pushing $(git -C "$REPO" branch --show-current) + ${TAG}…"
git -C "$REPO" push origin HEAD
git -C "$REPO" push origin "$TAG"

# --- GitHub Release ----------------------------------------------------------
notes_args=(--generate-notes)
[ -n "$NOTES_FILE" ] && notes_args=(--notes-file "$NOTES_FILE")
gh release create "$TAG" \
  "$DIST"/*.tar.gz "$DIST/SHA256SUMS.txt" \
  --title "PocketShell $TAG" \
  --verify-tag \
  "${notes_args[@]}"
echo "[release] published: $(gh release view "$TAG" --json url -q .url)"
