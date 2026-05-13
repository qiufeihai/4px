## Unreleased

### Added

### Changed

- 管理后台的资源页与日志页现在优先读取数据面进程视角，避免把 admin 子进程自身状态误当成服务端运行状态
- Node 文档补充 `cluster + memory` 的设备租约限制说明，明确此组合下活跃设备数与设备上限可能全局不一致，严格限制场景应使用 Redis
- 设备数超限响应补充 `x-auth-reason=device_limit_exceeded`，便于客户端准确识别并展示设备上限提示
- 设备数限制改为强制按客户端稳定 `x-device-id` 识别终端；设备票据仍保留 IP 绑定用于防盗用，但设备租约键不再混入出口 IP。旧版未携带 `x-device-id` 的客户端将被服务端拒绝，不再兼容
- 服务端 `deviceTicket` 收口为固定启用与固定要求，不再支持 `enabled=false` / `require=false` 配置语义；示例配置与文档同步移除这些旧开关
- 删除 `deviceLeaseStore.bindPeerIp` 与设备票据里的源 IP 绑定；`device_ticket` 仅保留签发、校验与自愈职责，避免网络切换时无意义重签

### Fixed

- 修复单进程 `deviceLeaseStore.mode=memory` 下管理后台“活跃设备数”读不到数据面租约的问题，改为通过 IPC 向数据面进程查询
- 为 `apps/node` 增加并清理最小 ESLint 校验，消除当前遗留 warning，降低 `xx is not defined` 等静态错误在部署后才暴露的风险

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
