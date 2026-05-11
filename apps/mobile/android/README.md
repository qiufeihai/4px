# 4px Android 客户端（MVP）

本文档用于本地开发与调试 Android 版（Trae + MuMu 场景）。

## 当前实现状态

- Android 客户端已改为仅保留 Go 一套协议逻辑（通过 `gomobile` 暴露 `tunbridge`）。
- 页面仅保留生产必要配置项：`host`、`port`、`auth token`（`device_ticket` 自动维护）。
- 连接流程：调用 Go bridge 的 `ConnectProbe` 成功后启动 `VpnService`。
- 断开流程：调用 Go bridge 的 `Offline`，并停止 `VpnService`。
- 数据面：`VpnService` + `tunbridge.Start/Stop` + `tun2socks` 转发。

## 本地环境要求

- 必需：
  - `JDK 17`
  - `Go`
  - `gomobile`、`gobind`
  - `Gradle`（当前仓库未提供 `gradlew`）
  - Android SDK：`platforms;android-34`、`build-tools;34.0.0`
  - Android NDK：`ndk;27.0.12077973`
- 建议：
  - `adb`（安装与日志排查更高效）
  - MuMu 模拟器（支持直接拖拽 APK 安装）

## 一键本地构建

在仓库根目录执行：

```bash
bash apps/mobile/android/scripts/build_local_debug.sh
```

脚本会自动完成：

- 校验 SDK/NDK/build-tools 依赖
- 同步 `gomobile` 版本并初始化
- 构建 `apps/go/tun2socks.aar`
- 复制到 `apps/mobile/android/app/libs/tun2socks.aar`
- 构建 `app-debug.apk`

默认产物路径：

- `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`

可选环境变量覆盖：

- `ANDROID_SDK_ROOT`
- `ANDROID_NDK_VERSION`
- `ANDROID_API_LEVEL`
- `ANDROID_BUILD_TOOLS_VERSION`
- `MOBILE_VERSION`

## Trae 沙箱注意事项

Trae 沙箱可能拦截 Kotlin 默认缓存目录（`~/Library/Application Support/kotlin`）。

当前脚本已内置项目内缓存重定向：

- `GRADLE_USER_HOME=apps/mobile/android/.gradle-user-home`
- `kotlin.user.home=apps/mobile/android/.kotlin-user-home`

如仍被拦截，请在 Trae 的 Sandbox 配置中放行上述两个项目内目录。

## 手动构建（不走脚本）

```bash
cd apps/go
gomobile bind -androidapi 26 -target=android/arm64,android/amd64 -o tun2socks.aar ./pkg/tunbridge
cp tun2socks.aar ../mobile/android/app/libs/tun2socks.aar

cd ../..
gradle -p apps/mobile/android :app:assembleDebug --no-daemon --parallel --build-cache \
  -Dkotlin.user.home=/Users/qiufeihai/github/4px/apps/mobile/android/.kotlin-user-home
```

## MuMu 调试流程

- 安装 APK（二选一）：
  - 直接把 APK 拖入 MuMu 窗口
  - 使用 `adb`：

```bash
adb connect 127.0.0.1:7555
adb -s 127.0.0.1:7555 install -r apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

- 查看日志：

```bash
adb -s 127.0.0.1:7555 logcat | grep -i -E "FourPxVpnService|tunbridge|clientcore|proxy|offline|error|fatal"
```

## 使用说明

- 点击“连接”后，先完成协议探测，再拉起 VPN。
- 点击“断开”后，会调用离线接口并停止 VPN。
- 若出现证书主机名校验失败，请使用证书匹配的域名，不要直接填 IP。
