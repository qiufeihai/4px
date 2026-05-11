# 4px iOS 客户端（MVP）

本文档用于 Trae 本地开发 iOS 第一版（控制面 + 数据面骨架）。

## 当前实现范围

- 界面简约且中文化，仅保留生产必要输入：`host`、`port`、`auth token`。
- 复用 Go `clientcore`：通过 `gomobile bind` 的 `tunbridge` 调用：
  - `ConnectProbe`
  - `Offline`
  - `SessionStatus`
- 已加入 `PacketTunnel` Extension 数据面骨架（`NetworkExtension`）。
- 连接失败提供中文提示（过期、授权失败、设备上限、证书错误、超时等）。
- 支持有效期查询（手动刷新）。
- 支持日志查询（最近 200 条，支持清空）。

说明：当前为数据面第二阶段（进行中），已在 `PacketTunnelProvider` 内启用默认路由并调用 Go bridge `StartWithConfig` 启动 `tunbridge/tun2socks`；仍需真机联调验证完整转发稳定性。

## 目录结构

- `project.yml`：XcodeGen 工程描述（不直接提交 `xcodeproj`）。
- `FourPxIOSApp/`：SwiftUI 源码。
- `PacketTunnelExtension/`：iOS 数据面扩展源码。
- `Frameworks/tun2socks.xcframework`：Go bridge 产物（本地生成，不入库）。
- `scripts/build_local_debug.sh`：一键本地构建脚本。

## 本地环境要求

- Xcode（含命令行工具）
- `xcodegen`
- Go
- `gomobile`/`gobind`

安装 `xcodegen`：

```bash
brew install xcodegen
```

## 一键构建（推荐）

在仓库根目录执行：

```bash
bash apps/mobile/ios/scripts/build_local_debug.sh
```

脚本会自动完成：

- 同步 `golang.org/x/mobile` 版本并初始化 `gomobile`
- 生成 `apps/mobile/ios/Frameworks/tun2socks.xcframework`
- 根据 `project.yml` 生成 `FourPxIOS.xcodeproj`
- 构建 iOS 模拟器 Debug 包

## Xcode 下载中如何继续推进

如果本机 Xcode 还在下载，你仍可继续两件事：

- 先改 `FourPxIOSApp/` 下的 Swift 业务代码（UI、文案、错误映射、日志逻辑）。
- 使用 GitHub Actions 的 iOS workflow 云端构建（见下文），先拿到可运行产物验证。

## 手动构建

```bash
cd apps/go
gomobile bind -target=ios,iossimulator -iosversion 15.0 -o ../mobile/ios/Frameworks/tun2socks.xcframework ./pkg/tunbridge

cd ../mobile/ios
xcodegen generate
xcodebuild -project FourPxIOS.xcodeproj -scheme FourPxIOS -configuration Debug -sdk iphonesimulator build
```

## Workflow 云构建（Xcode 未就绪时推荐）

仓库已提供手动触发工作流：

- `.github/workflows/ios-build.yml`

触发后会自动：

- 构建 `tun2socks.xcframework`
- 生成 `FourPxIOS.xcodeproj`
- 归档并导出已签名 `ipa`
- 可选自动上传到 TestFlight（内部测试）

### Workflow 所需 Secrets

以下 Secrets 需在 GitHub 仓库 `Settings -> Secrets and variables -> Actions` 配置：

- `IOS_TEAM_ID`：Apple Developer Team ID。
- `IOS_CERT_P12_BASE64`：iOS 发布证书 `.p12` 的 base64 内容。
- `IOS_CERT_PASSWORD`：该 `.p12` 证书密码。
- `IOS_PROVISION_APP_BASE64`：主 App 的 App Store provisioning profile（base64）。
- `IOS_PROVISION_EXTENSION_BASE64`：`PacketTunnelExtension` 的 App Store provisioning profile（base64）。
- `ASC_API_KEY_ID`：App Store Connect API Key ID（上传 TestFlight 用）。
- `ASC_API_ISSUER_ID`：App Store Connect API Issuer ID。
- `ASC_API_PRIVATE_KEY`：App Store Connect API 私钥内容（`.p8` 原文）。

## 使用说明

- 输入 `host/port/token` 后点击“连接”执行控制面探测并启动 VPN。
- 点击“断开”上报离线。
- 点击“刷新有效期”查询剩余天数/过期状态。
- 点击“查看日志”可查看最近日志并清空。
- 连接后会尝试启动 iOS `PacketTunnel` 数据面并接管默认路由。
- 若启动失败，界面会显示中文错误并保留日志用于排查。

## 常见问题

- 提示 `go bridge not available`：
  - 说明 `tun2socks.xcframework` 未正确生成或未被工程加载。
  - 重新运行一键脚本即可。
- 提示证书主机名错误：
  - 请使用证书匹配的域名，不要直接使用 IP。
- iOS 真机限制：
  - VPN 完整数据面验证需要真机；模拟器只能做大部分界面和流程验证。
