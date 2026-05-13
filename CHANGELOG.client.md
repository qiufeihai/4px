## Unreleased

### Added

### Changed

### Fixed

### Removed

### Security

## v1.2.0 - 2026-05-13

### Added

- Go 客户端核心 `clientcore` 与 `tunbridge`（供 GUI/移动端复用）
- Android 客户端 MVP（VPN 数据面 + Go bridge），并支持 release 签名产物输出
- iOS 客户端 MVP（含 PacketTunnel 数据面骨架与启动链路）
- 全链路会话保活：客户端定期 `/session/ping`，空闲后恢复无需手动重启

### Changed

- CI/本地构建脚本优化：缓存、产物命名、修复硬编码绝对路径
- GUI 构建工作流修正 wails CLI 安装的版本号引用，兼容 Windows runner
- 同步 Android/iOS 应用内版本号与仓库 `VERSION.client`
- 新增 AI 协作开发规则与约束文档（不改变运行逻辑）
