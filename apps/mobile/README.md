# Mobile Clients

移动端目录仅做导航，具体开发与构建说明以下级 README 为准。

## 目录

- `android/`：Android 客户端（`VpnService + tun2socks`，复用 Go `clientcore`）
- `ios/`：iOS 客户端（`PacketTunnel + tun2socks`，复用 Go `clientcore`）

## 统一约束

- 协议与会话能力复用 Go 核心，不维护移动端独立协议栈。
- UI 保持简约中文，保留有效期查询与日志查询能力。
- 会话机制与桌面端一致：`/session/ping` 保活、`/session/offline` 显式离线、TTL 兜底。

## 入口文档

- Android：`apps/mobile/android/README.md`
- iOS：`apps/mobile/ios/README.md`
