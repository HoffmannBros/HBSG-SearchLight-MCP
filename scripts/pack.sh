#!/usr/bin/env bash
# Build, validate, and pack the Claude Desktop bundle, then prove the archive
# is complete, self-contained, and free of secrets.
#
#   npm run pack            -> dist/hbsg-searchlight-<version>.mcpb
set -euo pipefail
cd "$(dirname "$0")/.."

die() { printf 'pack.sh: %s\n' "$1" >&2; exit 1; }

PKG_VERSION=$(node -p "require('./package.json').version")
MAN_VERSION=$(node -p "require('./manifest.json').version")
SRC_VERSION=$(sed -n 's/^export const VERSION = "\(.*\)";$/\1/p' src/version.ts)
[ "$PKG_VERSION" = "$MAN_VERSION" ] || die "version mismatch: package.json=$PKG_VERSION manifest.json=$MAN_VERSION"
[ "$PKG_VERSION" = "$SRC_VERSION" ] || die "version mismatch: package.json=$PKG_VERSION src/version.ts=$SRC_VERSION"
VERSION="$PKG_VERSION"

echo "==> Building $VERSION"
npm run --silent build

echo "==> Validating manifest"
npx --no-install mcpb validate manifest.json

mkdir -p dist
OUT="dist/hbsg-searchlight-$VERSION.mcpb"
rm -f "$OUT"
echo "==> Packing $OUT"
npx --no-install mcpb pack . "$OUT" >/dev/null

echo "==> Checking archive contents"
ACTUAL=$(unzip -Z1 "$OUT" | grep -v '/$' | sort)
EXPECTED=$(printf '%s\n' README.md icon.png manifest.json package.json server/index.cjs | sort)
if [ "$ACTUAL" != "$EXPECTED" ]; then
  printf 'expected:\n%s\nactual:\n%s\n' "$EXPECTED" "$ACTUAL" >&2
  die "archive contents differ from the expected five files"
fi

echo "==> Scanning for secrets"
if unzip -p "$OUT" | grep -aEo 'sl_[A-Za-z0-9]{8,}' | head -1 | grep -q .; then
  die "an sl_ key-shaped string is inside the bundle"
fi
if [ -f .env ]; then
  KEY=$(sed -n 's/^SEARCHLIGHT_API_KEY=//p' .env | tr -d '"'"'"' ' | head -1)
  if [ -n "$KEY" ] && unzip -p "$OUT" | grep -aqF "$KEY"; then
    die "the API key from .env is inside the bundle"
  fi
fi

echo "==> Verifying the bundle runs from a clean unpack"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
unzip -q "$OUT" -d "$TMP"
npx --no-install tsx scripts/handshake.ts "$TMP/server/index.cjs" 9

SIZE=$(du -h "$OUT" | cut -f1)
echo "==> OK: $OUT ($SIZE)"
