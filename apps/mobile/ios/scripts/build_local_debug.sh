#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
IOS_DIR="$ROOT_DIR/apps/mobile/ios"
GO_DIR="$ROOT_DIR/apps/go"
FRAMEWORK_DIR="$IOS_DIR/Frameworks"
FRAMEWORK_PATH="$FRAMEWORK_DIR/tun2socks.xcframework"
SCHEME="FourPxIOS"
PROJECT="$IOS_DIR/FourPxIOS.xcodeproj"
DERIVED_DATA="$IOS_DIR/.derivedData"

MOBILE_VERSION="${MOBILE_VERSION:-v0.0.0-20260508232728-bebd421c7fa8}"
IOS_SDK_MIN="${IOS_SDK_MIN:-15.0}"

echo "==> 检查依赖"
command -v go >/dev/null || { echo "缺少 go"; exit 1; }
command -v gomobile >/dev/null || { echo "缺少 gomobile"; exit 1; }
command -v xcodegen >/dev/null || { echo "缺少 xcodegen（brew install xcodegen）"; exit 1; }
command -v xcodebuild >/dev/null || { echo "缺少 xcodebuild（需安装 Xcode）"; exit 1; }
if ! xcode-select -p | grep -q "/Applications/Xcode.app/Contents/Developer"; then
  cat <<'EOF'
当前 xcode-select 未指向完整 Xcode，iOS 构建会失败。
请执行：
  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
  sudo xcodebuild -license accept
  sudo xcodebuild -runFirstLaunch
EOF
  exit 1
fi
if ! xcrun --sdk iphoneos --show-sdk-path >/dev/null 2>&1; then
  echo "未检测到 iphoneos SDK，请确认 Xcode 下载和首次初始化已完成。"
  exit 1
fi

echo "==> 同步 gomobile 版本: $MOBILE_VERSION"
cd "$GO_DIR"
go get "golang.org/x/mobile/bind@${MOBILE_VERSION}"
go install "golang.org/x/mobile/cmd/gomobile@${MOBILE_VERSION}"
go install "golang.org/x/mobile/cmd/gobind@${MOBILE_VERSION}"
export PATH="$(go env GOPATH)/bin:$PATH"
gomobile init

echo "==> 生成 tun2socks.xcframework"
mkdir -p "$FRAMEWORK_DIR"
gomobile bind \
  -target=ios,iossimulator \
  -iosversion "$IOS_SDK_MIN" \
  -o "$FRAMEWORK_PATH" \
  ./pkg/tunbridge

echo "==> 生成 Xcode 工程"
cd "$IOS_DIR"
xcodegen generate
# Xcode 15.2 compatibility: avoid newer project format that may crash inspector.
if [ -f "$PROJECT/project.pbxproj" ]; then
  sed -i '' 's/objectVersion = 77;/objectVersion = 60;/g' "$PROJECT/project.pbxproj"
  sed -i '' 's/preferredProjectObjectVersion = 77;/preferredProjectObjectVersion = 60;/g' "$PROJECT/project.pbxproj"
fi

echo "==> 构建 iOS Debug 包（模拟器）"
xcodebuild \
  -project "$PROJECT" \
  -scheme "$SCHEME" \
  -configuration Debug \
  -sdk iphonesimulator \
  -derivedDataPath "$DERIVED_DATA" \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  build

echo "==> 完成"
echo "工程：$PROJECT"
echo "模拟器构建产物：$DERIVED_DATA/Build/Products/Debug-iphonesimulator"
