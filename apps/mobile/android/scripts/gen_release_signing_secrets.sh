#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANDROID_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

fail() {
  echo "[gen_release_signing_secrets] $*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"
}

require_cmd keytool
require_cmd openssl
require_cmd base64

KEYSTORE_DIR="${KEYSTORE_DIR:-$ANDROID_DIR/.keystore}"
KEYSTORE_PATH="${KEYSTORE_PATH:-$KEYSTORE_DIR/fourpx-release.jks}"
ANDROID_KEY_ALIAS="${ANDROID_KEY_ALIAS:-fourpx}"
ANDROID_KEYSTORE_PASSWORD="${ANDROID_KEYSTORE_PASSWORD:-}"
ANDROID_KEY_PASSWORD="${ANDROID_KEY_PASSWORD:-}"
ANDROID_KEY_DNAME="${ANDROID_KEY_DNAME:-CN=4px, OU=4px, O=4px, L=, ST=, C=CN}"

mkdir -p "$KEYSTORE_DIR"

if [[ -z "$ANDROID_KEYSTORE_PASSWORD" ]]; then
  ANDROID_KEYSTORE_PASSWORD="$(openssl rand -hex 24)"
fi
if [[ -z "$ANDROID_KEY_PASSWORD" ]]; then
  ANDROID_KEY_PASSWORD="$ANDROID_KEYSTORE_PASSWORD"
fi

if [[ ! -f "$KEYSTORE_PATH" ]]; then
  keytool -genkeypair -v \
    -storetype JKS \
    -keystore "$KEYSTORE_PATH" \
    -alias "$ANDROID_KEY_ALIAS" \
    -keyalg RSA -keysize 2048 -validity 36500 \
    -storepass "$ANDROID_KEYSTORE_PASSWORD" \
    -keypass "$ANDROID_KEY_PASSWORD" \
    -dname "$ANDROID_KEY_DNAME" >/dev/null
fi

KEYSTORE_BASE64="$(base64 <"$KEYSTORE_PATH" | tr -d '\n')"
[[ -n "$KEYSTORE_BASE64" ]] || fail "failed to encode keystore"

echo ""
echo "[gen_release_signing_secrets] keystore: $KEYSTORE_PATH"
echo ""
echo "复制粘贴到 GitHub -> Settings -> Secrets and variables -> Actions："
echo ""
echo "ANDROID_KEYSTORE_BASE64=$KEYSTORE_BASE64"
echo "ANDROID_KEYSTORE_PASSWORD=$ANDROID_KEYSTORE_PASSWORD"
echo "ANDROID_KEY_ALIAS=$ANDROID_KEY_ALIAS"
echo "ANDROID_KEY_PASSWORD=$ANDROID_KEY_PASSWORD"
echo ""
echo "本地临时使用（可选）："
echo "export ANDROID_KEYSTORE_PATH=\"$KEYSTORE_PATH\""
echo "export ANDROID_KEYSTORE_PASSWORD=\"$ANDROID_KEYSTORE_PASSWORD\""
echo "export ANDROID_KEY_ALIAS=\"$ANDROID_KEY_ALIAS\""
echo "export ANDROID_KEY_PASSWORD=\"$ANDROID_KEY_PASSWORD\""
echo ""
