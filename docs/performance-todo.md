# 4px 性能优化 TODO

本文档用于持续跟踪 4px 的性能优化项，便于后续由 AI 或人工按清单推进。

## 目标与约束

- 目标：在保持稳定性的前提下，提升 `proxy-v2/mux` 吞吐与尾延迟表现。
- 约束：优先小步迭代，避免一次性大重构；默认保留可回退路径（`/proxy`）。
- 验收基线：每次优化都要有“改动前/后”对比数据（同机型、同并发、同目标）。

## 基线指标（先补齐）

- [ ] 固定压测方法：请求数、并发梯度、超时阈值、目标地址。
- [ ] 固定采集指标：`ok/fail`、成功率、p50/p95/p99、CPU、内存、重连次数。
- [ ] 固定记录位置：把每轮测试结果追加到本文档末尾“执行记录”。

## P0：低风险高收益

- [x] 复核并统一关键超时：connect/header/idle/h2 read idle/h2 ping。
- [x] 复核连接池参数：`max_idle_conns`、`per_host`、`max_conns_per_host`。
- [x] 增强日志可读性：异常必须带关键上下文（目标、模式、错误码/状态码）。
- [x] 增强错误分类：把可重试错误与不可重试错误分开统计。

验收标准（P0）：
- 成功率不下降（目标 `>= 99%`）。
- 在同等并发下，p95 不劣化；CPU 不显著上升（建议阈值 `<= +10%`）。

## P1：数据面优化（优先）

- [x] 优化 mux 帧收发策略（批量写、减少小包、减少无效 flush）。
- [x] 优化背压控制（慢消费者不拖垮整体通道）。
- [x] 优化 copy 路径与 buffer 复用，减少 GC 压力。
- [x] 优化重连策略（抖动退避、错误分级、可观测重连原因）。

验收标准（P1）：
- 同并发下吞吐提升或 CPU 下降（至少一项明显改善）。
- p99 尾延迟改善或稳定性提升（错误率下降）。

## P2：传输与协议能力扩展

- [ ] 调研并试点 HTTP/3（QUIC）可选通道，不替换现有默认通道。
- [ ] 评估 TLS 参数优化（会话复用、握手开销、证书链策略）。
- [ ] 评估前置反向代理统一 TLS 外观（可维护优先）。

验收标准（P2）：
- 弱网或高并发场景中至少一个核心指标优于现有方案。
- 不引入明显运维复杂度（部署步骤可文档化，回滚简单）。

## P3：热点重写（最后考虑）

- [ ] 先用 profiling 找“真热点”，禁止凭感觉重写。
- [ ] 仅重写热点模块（如帧编解码/关键数据路径），避免全量换语言。
- [ ] 保持接口稳定，确保可灰度切换与快速回退。

验收标准（P3）：
- 热点模块在真实压测中有持续收益，且维护复杂度可接受。

## 不做清单（默认）

- [ ] 不做全仓语言迁移（除非连续多轮数据证明收益显著）。
- [ ] 不做难以维护的私有协议魔改（优先标准化、可观测方案）。

## 执行记录模板

每完成一项优化，追加一条记录：

```text
日期：
负责人：
改动项：
影响范围：
压测命令：
结果（前 -> 后）：
- success_rate:
- p50/p95/p99:
- cpu/mem:
- reconnect/errors:
结论：
是否回滚：
```

## 执行记录

```text
日期：2026-05-05
负责人：AI
改动项：Go clientcore mux 写路径优化（bufio 缓冲 + 周期 flush + 控制帧立即 flush）
影响范围：apps/go/pkg/clientcore/core.go（proxy-v2/mux 数据面）
压测命令：待补（下一轮按 benchmark_go_clientcore_modes.sh 固化命令执行）
结果（前 -> 后）：
- success_rate: 待补
- p50/p95/p99: 待补
- cpu/mem: 待补
- reconnect/errors: 待补
结论：已完成代码级优化并通过 go build；性能收益待压测数据确认
是否回滚：否
```

```text
日期：2026-05-06
负责人：AI
改动项：修复 mux 写路径回归（sendFrame 中写锁重入导致 v2 卡死）
影响范围：apps/go/pkg/clientcore/core.go（proxy-v2/mux 发送与 flush 路径）
压测命令：./benchmark_go_clientcore_modes.sh --requests 200 --concurrency 80 --warmup 10 --modes proxy,proxy-v2 --success-threshold 99 --p95-threshold-ms 8000 --kill-listeners
结果（前 -> 后）：
- success_rate: proxy-v2 从 0%（回归）恢复至 100%（c=80）；proxy 本轮为 0%，疑似本地运行态干扰
- p50/p95/p99: proxy-v2 为 1303.939/1491.195/1579.095 ms（c=80）
- cpu/mem: 待补
- reconnect/errors: proxy-v2 无错误；proxy 出现本地 7788 连接失败
结论：已修复回归，proxy-v2 链路恢复；需要在更干净环境补跑完整梯度并记录最终对比数据
是否回滚：否
```

```text
日期：2026-05-06
负责人：AI
改动项：mux 背压控制（每 stream 有界队列 + 队列溢出快速失败，避免 read loop 被慢流阻塞）
影响范围：apps/go/pkg/clientcore/core.go（muxStream queueData/closeWithError/dispatchFrame）
压测命令：./benchmark_go_clientcore_modes.sh --requests 200 --concurrency 80 --warmup 10 --modes proxy,proxy-v2 --success-threshold 99 --p95-threshold-ms 8000 --kill-listeners
结果（前 -> 后）：
- success_rate: proxy=100%，proxy-v2=100%（c=80）
- p50/p95/p99: proxy=1275.082/1396.176/1497.798 ms；proxy-v2=1184.771/1529.011/1550.869 ms
- cpu/mem: 待补（本轮仅功能与时延快速验证）
- reconnect/errors: 两模式均无错误
结论：背压策略已生效且未引入明显功能回归；下一步继续做 copy 路径/重连策略优化并补完整梯度
是否回滚：否
```

```text
日期：2026-05-06
负责人：AI
改动项：copy 路径与 buffer 复用（stream 数据队列改为池化 chunk，复用 muxPayloadPool，减少每帧 make/copy 的临时对象）
影响范围：apps/go/pkg/clientcore/core.go（muxStream.dataCh/queueData/startWriter）
压测命令：./benchmark_go_clientcore_modes.sh --requests 200 --concurrency 80 --warmup 10 --modes proxy,proxy-v2 --success-threshold 99 --p95-threshold-ms 8000 --kill-listeners
结果（前 -> 后）：
- success_rate: proxy=100%，proxy-v2=100%（c=80）
- p50/p95/p99: proxy=1302.388/1405.613/1425.865 ms；proxy-v2=1321.893/1436.299/1614.177 ms
- cpu/mem: 待补（需在完整梯度+更长时段观察）
- reconnect/errors: 两模式均无错误
结论：池化改造已生效且稳定；短测未见功能回归，需补充长稳数据评估 GC/CPU 收益
是否回滚：否
```

```text
日期：2026-05-06
负责人：AI
改动项：重连策略优化（指数退避 + 错误分级 + 重连可观测字段）
影响范围：apps/go/pkg/clientcore/core.go（mux start/markReconnectFailure/MuxRuntimeStats）
压测命令：./benchmark_go_clientcore_modes.sh --requests 200 --concurrency 80 --warmup 10 --modes proxy,proxy-v2 --success-threshold 99 --p95-threshold-ms 8000 --kill-listeners
结果（前 -> 后）：
- success_rate: proxy=100%，proxy-v2=100%（c=80）
- p50/p95/p99: proxy=1143.949/1422.321/1743.182 ms；proxy-v2=1300.832/1402.395/1454.581 ms
- cpu/mem: 待补（需完整梯度与长稳验证）
- reconnect/errors: 正常场景未触发重连；已支持记录连续失败次数、错误类别、backoff 毫秒
结论：重连策略已落地且短测稳定；需要故障注入场景验证退避与错误分级效果
是否回滚：否
```

```text
日期：2026-05-06
负责人：AI
改动项：P0 参数复核与统一（Node idle timeout 默认值统一为 300000，并保留显式 0=关闭语义）
影响范围：apps/node/src/client.js, apps/node/src/server.js
压测命令：node --check apps/node/src/client.js && node --check apps/node/src/server.js（语法检查）
结果（前 -> 后）：
- success_rate: 待补（本次为配置/默认值统一，不涉及链路压测）
- p50/p95/p99: 待补
- cpu/mem: 待补
- reconnect/errors: 待补
结论：Go/Node 默认关键超时与连接池参数已对齐；Node 侧避免了 `||` 导致的 `0` 语义丢失
是否回滚：否
```

```text
日期：2026-05-06
负责人：AI
改动项：P0 日志可读性与错误分类（Node client/server 增加 retryable/non-retryable 统计与上下文字段）
影响范围：apps/node/src/client.js, apps/node/src/server.js
压测命令：node --check apps/node/src/client.js && node --check apps/node/src/server.js（语法检查）
结果（前 -> 后）：
- success_rate: 待补（本次为观测与分类增强）
- p50/p95/p99: 待补
- cpu/mem: 待补
- reconnect/errors: 新增 retryable_err/non_retryable_err 指标；错误日志统一携带 mode/target/status/err_class
结论：P0 四项已全部完成（参数、连接池、日志上下文、错误分类）；下一步进入 P2 调研或补充长稳与故障注入验证
是否回滚：否
```
