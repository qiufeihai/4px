## Unreleased

### Added

### Changed

- Android 连接成功后的状态展示改为先等待 VPN 数据面就绪，再标记为“VPN 已启动”，降低“看起来已连接但实际没网”的误判
- Android 与桌面 GUI 补充更多错误场景提示，包括设备票据失效、账号禁用/过期、未填写令牌、接口不匹配、目标站点不可达、服务端过载等

### Fixed

- 修复 Android 在部分构建环境下依赖 `BuildConfig` 读取版本号导致 release Kotlin 编译失败的问题
- 修复 Android 与桌面 GUI 在设备数超限、设备票据失效等场景下提示不准确或缺失的问题
- 改进 Android VPN 启动失败与 bridge 调用失败的日志可见性，便于排查“连接成功但无法联网”

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
