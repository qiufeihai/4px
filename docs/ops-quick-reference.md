# 4px 运维速查

适用范围：当前默认主路径 `/proxy`。

## 快速判断

- `remote connection error` 且 `err_code=ENETUNREACH`（IPv6 地址）：优先检查服务器 IPv6 出口；无 IPv6 出口时保持 `remoteDnsPreferIPv4=true`。
- `remote_connect_overload_reject` 持续增长：建连并发阈值过低或瞬时突发过高，重点检查 `remoteConnectMaxInFlight` 与 `remoteConnectOverloadWaitMs`。
- `eventloop_p95_ms` 持续偏高：可能存在建连风暴或日志风暴，先收敛并发和日志频率。
- `connect_ms` 低但 `ttfb_ms` 高：问题更可能在目标站/CDN 响应链路，不在代理建连阶段。

## 关键指标

- 建连压力：`remote_connect_inflight`、`remote_connect_inflight_peak`
- 过载保护：`remote_connect_overload_reject`、`remote_connect_overload_reject_by_host`
- DNS 质量：`remote_dns_cache_hit`、`remote_dns_negative_cache_hit`、`remote_dns_resolve_error`
- 熔断状态：`remote_circuit_reject`、`remote_circuit_open_total`
- 运行时抖动：`eventloop_p95_ms`

## 最小排查顺序

1. 看错误类型：先确认是 `connect` 阶段还是 `relay` 阶段错误。
2. 看网络可达：检查目标域名解析和服务器出口连通性（IPv4/IPv6）。
3. 看过载信号：检查过载拒绝与 in-flight 是否长期贴边。
4. 看事件循环：若 `eventloop_p95_ms` 偏高，优先降噪和削峰。
5. 做单变量调参：每次只改 1 个参数并观察一个完整高峰周期。

## 术语

- `server`：基于 HTTP/2 隧道的正向代理服务端（Node）
- `client`：本地代理入口（Node 或 Go）
- `主路径`：`/proxy`
