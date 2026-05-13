## Unreleased

### Added

### Changed

- 管理后台的资源页与日志页现在优先读取数据面进程视角，避免把 admin 子进程自身状态误当成服务端运行状态
- Node 文档补充 `cluster + memory` 的设备租约限制说明，明确此组合下活跃设备数与设备上限可能全局不一致，严格限制场景应使用 Redis

### Fixed

- 修复单进程 `deviceLeaseStore.mode=memory` 下管理后台“活跃设备数”读不到数据面租约的问题，改为通过 IPC 向数据面进程查询

### Removed

### Security

## v1.2.0 - 2026-05-13

### Added

- 设备租约存储与设备数限制（支持集群部署的设备限制与准入）
- 设备票据 `x-device-ticket` 机制（替换旧的客户端实例 ID 思路）
- 会话控制面：`/session/status`、`/session/ping`、`/session/offline`
- 管理面与指标上报独立进程（降低对数据面事件循环的干扰）

### Changed

- 集群模式下指标改为主进程汇聚输出，避免每个 worker 刷一套指标日志
- 默认配置与性能参数整理（以稳定为先）
- 设备租约存储示例配置默认切换为内存模式（如需集群严格限制可改为 Redis）
- 同步 `apps/node/package.json` 版本号与仓库 `VERSION.server`
