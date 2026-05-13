#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RELEASE_DIR="$ROOT_DIR/releases"
VERSION=""

usage() {
  cat <<'EOF'
Usage:
  ./scripts/package_gui.sh [--version v0.6.0]

Options:
  --version <ver>   Optional version label. If empty, uses timestamp.
  -h, --help        Show help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ -z "$VERSION" ]]; then
  VERSION="$(date +%Y%m%d-%H%M%S)"
fi

if command -v wails >/dev/null 2>&1; then
  WAILS_CMD="wails"
else
  WAILS_CMD="$(go env GOPATH)/bin/wails"
fi

if [[ ! -x "$WAILS_CMD" && "$WAILS_CMD" != "wails" ]]; then
  echo "wails CLI not found. Install with:" >&2
  echo "  go install github.com/wailsapp/wails/v2/cmd/wails@latest" >&2
  exit 1
fi

if git -C "$ROOT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  GITSHA="$(git -C "$ROOT_DIR" rev-parse --short HEAD)"
else
  GITSHA="nogit"
fi
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "Building GUI package..."
(cd "$ROOT_DIR" && "$WAILS_CMD" build -clean -ldflags "-X main.AppVersion=$VERSION -X main.GitSHA=$GITSHA -X main.BuildTime=$BUILT_AT")

APP_PATH="$(find "$ROOT_DIR/build/bin" -maxdepth 1 -name "*.app" -type d | head -n 1)"
if [[ -z "$APP_PATH" ]]; then
  echo "No .app bundle found under $ROOT_DIR/build/bin" >&2
  exit 1
fi

PLATFORM="darwin"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
esac

mkdir -p "$RELEASE_DIR"
ARTIFACT="4px-client_${VERSION}_${PLATFORM}_${ARCH}_${GITSHA}"
ARTIFACT_PATH="$RELEASE_DIR/$ARTIFACT"

echo "Packaging: $ARTIFACT_PATH"
rm -rf "$ARTIFACT_PATH"
mkdir -p "$ARTIFACT_PATH"
cp -R "$APP_PATH" "$ARTIFACT_PATH/"

META_PATH="$RELEASE_DIR/${ARTIFACT}.meta.txt"
{
  echo "artifact=$ARTIFACT"
  echo "version=$VERSION"
  echo "platform=$PLATFORM"
  echo "arch=$ARCH"
  echo "gitsha=$GITSHA"
  echo "source_app=$(basename "$APP_PATH")"
  echo "built_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$META_PATH"

echo "Done."
echo "dir:  $ARTIFACT_PATH"
echo "meta: $META_PATH"
