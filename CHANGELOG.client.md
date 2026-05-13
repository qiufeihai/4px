## Unreleased

### Added

### Changed

- Android 连接成功后的状态展示改为先等待 VPN 数据面就绪，再标记为“VPN 已启动”，降低“看起来已连接但实际没网”的误判
- Android 与桌面 GUI 补充更多错误场景提示，包括设备票据失效、账号禁用/过期、未填写令牌、接口不匹配、目标站点不可达、服务端过载等
- 桌面 GUI 与 Android 进一步统一普通用户提示口径，补齐“客户端已在运行中”、停止提示、缺失设备标识等零散中文文案
- Android 与桌面 GUI 的有效期展示改为优先显示本地时间格式的到期时间，降低 ISO 时间串带来的理解成本

### Fixed

- 修复 Android 在部分构建环境下依赖 `BuildConfig` 读取版本号导致 release Kotlin 编译失败的问题
- 修复 Android 与桌面 GUI 在设备数超限、设备票据失效等场景下提示不准确或缺失的问题
- 修复 Android `missing_device_id` 被误判并展示为“设备数已达上限”的提示映射错误
- 改进 Android VPN 启动失败与 bridge 调用失败的日志可见性，便于排查“连接成功但无法联网”
- 修复 Android VPN 已连接但浏览器无法访问域名地址的问题：为共享 `clientcore` 的本地 SOCKS5 增加 DNS 所需的 `UDP ASSOCIATE` 支持；同时改善桌面 GUI 搭配 ZeroOmega 等 SOCKS5 客户端时的 DNS 兼容性
- 修复安卓与桌面 GUI 在同一出口网络下可能被服务端合并识别为同一设备、从而无法正确触发“最大设备数”限制的问题；客户端现为每台终端自动维护稳定 `device_id`，且旧版未携带 `x-device-id` 的客户端不再兼容

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
