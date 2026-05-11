#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANDROID_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$ANDROID_DIR/../../.." && pwd)"
GO_DIR="$REPO_ROOT/apps/go"

ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}"
ANDROID_NDK_VERSION="${ANDROID_NDK_VERSION:-27.0.12077973}"
ANDROID_API_LEVEL="${ANDROID_API_LEVEL:-34}"
ANDROID_BUILD_TOOLS_VERSION="${ANDROID_BUILD_TOOLS_VERSION:-34.0.0}"
MOBILE_VERSION="${MOBILE_VERSION:-v0.0.0-20260508232728-bebd421c7fa8}"
GRADLE_USER_HOME="${GRADLE_USER_HOME:-$ANDROID_DIR/.gradle-user-home}"
KOTLIN_USER_HOME="${KOTLIN_USER_HOME:-$ANDROID_DIR/.kotlin-user-home}"

fail() {
  echo "[build_local_debug] $*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"
}

echo "[build_local_debug] repo: $REPO_ROOT"
echo "[build_local_debug] android sdk: $ANDROID_SDK_ROOT"

require_cmd go
require_cmd gradle
require_cmd gomobile
require_cmd gobind

[[ -d "$ANDROID_SDK_ROOT" ]] || fail "ANDROID_SDK_ROOT not found: $ANDROID_SDK_ROOT"
[[ -d "$ANDROID_SDK_ROOT/platforms/android-$ANDROID_API_LEVEL" ]] || fail "missing SDK platform android-$ANDROID_API_LEVEL"
[[ -d "$ANDROID_SDK_ROOT/build-tools/$ANDROID_BUILD_TOOLS_VERSION" ]] || fail "missing build-tools $ANDROID_BUILD_TOOLS_VERSION"
[[ -f "$ANDROID_SDK_ROOT/ndk/$ANDROID_NDK_VERSION/meta/platforms.json" ]] || fail "missing NDK $ANDROID_NDK_VERSION"

export ANDROID_HOME="$ANDROID_SDK_ROOT"
export ANDROID_SDK_ROOT
export ANDROID_NDK_HOME="$ANDROID_SDK_ROOT/ndk/$ANDROID_NDK_VERSION"
export PATH="$(go env GOPATH)/bin:$PATH"
export GRADLE_USER_HOME

mkdir -p "$GRADLE_USER_HOME" "$KOTLIN_USER_HOME"

echo "[build_local_debug] sync gomobile version: $MOBILE_VERSION"
(
  cd "$GO_DIR"
  go get "golang.org/x/mobile/bind@$MOBILE_VERSION"
  go install "golang.org/x/mobile/cmd/gomobile@$MOBILE_VERSION"
  go install "golang.org/x/mobile/cmd/gobind@$MOBILE_VERSION"
  gomobile init
)

echo "[build_local_debug] build tun2socks aar"
(
  cd "$GO_DIR"
  gomobile bind \
    -androidapi 26 \
    -target=android/arm64,android/amd64 \
    -o tun2socks.aar \
    ./pkg/tunbridge
)

mkdir -p "$ANDROID_DIR/app/libs"
cp "$GO_DIR/tun2socks.aar" "$ANDROID_DIR/app/libs/tun2socks.aar"

echo "[build_local_debug] build debug apk"
(
  cd "$REPO_ROOT"
  gradle -p apps/mobile/android :app:assembleDebug \
    --no-daemon --parallel --build-cache \
    -Dkotlin.user.home="$KOTLIN_USER_HOME"
)

APK_PATH="$ANDROID_DIR/app/build/outputs/apk/debug/app-debug.apk"
[[ -f "$APK_PATH" ]] || fail "apk not found: $APK_PATH"

echo ""
echo "[build_local_debug] done"
echo "[build_local_debug] aar: $ANDROID_DIR/app/libs/tun2socks.aar"
echo "[build_local_debug] apk: $APK_PATH"
echo ""
echo "Install to MuMu:"
echo "1) Drag APK into MuMu window"
echo "2) Or use adb:"
echo "   adb connect 127.0.0.1:7555"
echo "   adb -s 127.0.0.1:7555 install -r \"$APK_PATH\""
