# 4px 性能优化 TODO

本文档用于持续跟踪 4px 的性能优化项，便于后续由 AI 或人工按清单推进。
说明：本文含历史实验记录（含 `proxy-v2`），用于回溯；当前默认主路径为 `/proxy`。

补充参考：分档选型速查见 `docs/perf-profile-recommendation.md`。

## 当前阶段（proxy-only）最小验收矩阵

适用前提：
- 当前主路径已收敛到 `/proxy`，不再把 `proxy-v2/mux` 作为默认验收对象。
- 目标优先级固定为：低延时、低抖动、高带宽、高稳定。
- 服务端改动必须先部署，再执行下述验收并记录结果。

执行口径（每次改动后都执行）：
- A 组（体感）：网页首开、视频连续播放、视频拖动后恢复时间。
- B 组（稳定）：30 分钟连续使用，观察断流次数、自动恢复次数、重连耗时。
- C 组（资源）：客户端和服务端 CPU/内存区间，确认无持续爬升。

通过标准（任一项不满足即不通过）：
- 网页与视频体感无明显劣化，视频拖动后恢复时间稳定。
- 连续 30 分钟无新增高频错误、无持续抖动、无明显断流。
- 资源曲线平稳，且未出现“延时下降但抖动上升”的反向优化。

最小记录模板：

```text
日期：
改动项：
部署版本（server/client）：
A组体感结果（网页/视频/拖动恢复）：
B组稳定结果（断流/重连/恢复耗时）：
C组资源结果（CPU/内存区间）：
结论（通过/不通过）：
是否回滚：
```

## 目标与约束（当前执行口径）

- 目标：在保持稳定性的前提下，持续优化 `/proxy` 的吞吐、尾延迟与可恢复性。
- 约束：优先小步迭代，避免一次性大重构；所有优化都必须可验证、可回退。
- 验收基线：每次优化都要有“改动前/后”对比数据（同机型、同并发、同目标）。

## 基线指标（先补齐）

- [x] 固定压测方法：请求数、并发梯度、超时阈值、目标地址。（`benchmark_go_clientcore_modes.sh` 新增 `--profile smoke|gradient|soak` 预设）
- [x] 固定采集指标：`ok/fail`、成功率、p50/p95/p99、CPU、内存、重连次数。（压测脚本 summary/compare 已自动采集 CPU 与 RSS）
- [x] 固定记录位置：把每轮测试结果追加到本文档末尾“执行记录”。

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

## P1-S：服务端数据面优化（新增）

- [ ] S1：`apps/node/src/server.js` 中 mux 出站队列从 `Array.shift()` 改为环形队列（降低高并发队列开销）。
- [ ] S2：服务端 mux flush 增加“字节阈值 + 最长延迟”批次策略（减少小包写与事件循环抖动）。
- [ ] S3：服务端 mux 帧解析路径减少内存拷贝与碎片（保持协议不变，仅优化实现）。
- [ ] S4：服务端 backpressure 增加分档水位（按并发档控制 pause/resume 触发频率）。
- [ ] S5：服务端多核利用（`cluster`/多 worker + 复用端口）并评估收益。
- [ ] S6：服务端观测增强（补充 queue 长度、flush 批次大小、remote connect 耗时分位）。

验收标准（P1-S）：
- 成功率不下降（`>= 99%`），错误分类计数无异常增长。
- `gradient + repeat=3` 中位值口径下，至少一个关键档位（c120 或 c160）`p95/p99` 改善且 CPU 不显著升高（建议 `<= +10%`）。
- 若收益不一致或仅单档位偶发改善，默认回滚，保持稳定优先。

执行顺序（P1-S）：
1. 先做 S1（低风险，代码面最小，预期收益稳定）。
2. 再做 S2（与 S1 组合验证）。
3. 仅在 S1/S2 稳定后再推进 S3/S4。
4. S5/S6 放在后半程，避免早期引入过多变量。

## P2：传输与协议能力扩展

- [ ] 调研并试点 HTTP/3（QUIC）可选通道，不替换现有默认通道。（暂不实现：当前网络环境对 UDP 不友好，优先维持 H2/TCP 主链路；仅在网络环境变化后再评估）
- [x] 评估 TLS 参数优化（会话复用、握手开销、证书链策略）。
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

## 单用户阶段最小验收清单（10 分钟）

适用场景：当前仅个人使用，重点验证“体感稳定性 + 基础可靠性”。

一键脚本：

```bash
cd /Users/qiufeihai/github/4px/apps/go
./single_user_validate.sh
```

前置条件：
- [ ] 服务端已部署最新改动后再验收（部署前数据不计入结论）。
- [ ] 客户端保持默认配置（建议 `mux_tuning_profile=balanced`），不临时改参数。

执行步骤（建议连续完成）：
- [ ] 冷启动：从启动客户端到可用，记录耗时（秒）。
- [ ] 首个请求：打开常用页面/接口，记录首包耗时（毫秒）。
- [ ] 连续操作 3 分钟：按真实路径使用，观察是否卡顿、断流、报错。
- [ ] 后台驻留 3 分钟：不操作，观察是否异常重连或连接抖动。
- [ ] 恢复场景：进行一次网络切换/重连，确认可自动恢复。
- [ ] 资源观察：记录 CPU/内存区间，确认无持续上涨。
- [ ] 移动端（iOS/Android）动作验证：当前版本暂不支持，后续支持后补测前后台切换/锁屏唤醒/断网恢复。

通过标准（单用户口径）：
- [ ] 连续两次执行结果波动小（无明显慢首包、无明显慢恢复）。
- [ ] 无断流、无明显卡顿、无新增高频错误。
- [ ] 资源曲线平稳（CPU/内存无持续爬升）。

异常记录模板（出现问题时补充）：

```text
时间点：
操作步骤：
现象描述：
持续时长：
是否可复现（是/否）：
相关日志关键字：
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

```text
日期：2026-05-06
负责人：AI
改动项：基线能力补齐（Go 压测脚本新增 profile 预设 + 客户端进程 CPU/RSS 自动采样并写入 summary/compare）
影响范围：apps/go/benchmark_go_clientcore_modes.sh
压测命令：bash -n apps/go/benchmark_go_clientcore_modes.sh（语法检查）；后续建议 ./benchmark_go_clientcore_modes.sh --profile gradient --success-threshold 99 --p95-threshold-ms 8000 --kill-listeners
结果（前 -> 后）：
- success_rate: 指标口径不变（ok/fail 与延迟分位保持）
- p50/p95/p99: 指标口径不变（新增统一 profile 便于横向对比）
- cpu/mem: 新增 `cpu_pct_avg/cpu_pct_max/rss_mb_avg/rss_mb_max/resource_samples`
- reconnect/errors: 指标口径不变（沿用既有 summary 字段）
结论：基线“固定压测方法+固定采集指标+固定记录位置”已落地，后续优化可直接按统一模板执行
是否回滚：否
```

```text
日期：2026-05-06
负责人：AI
改动项：执行 gradient 基线压测并补齐 CPU/RSS 指标样本
影响范围：apps/go/benchmark_go_clientcore_modes.sh（执行层）；apps/go/benchmarks_go/20260506_101729（结果）
压测命令：./benchmark_go_clientcore_modes.sh --profile gradient --success-threshold 99 --p95-threshold-ms 8000 --kill-listeners
结果（前 -> 后）：
- success_rate: proxy(c80)=9.8%（启动窗口干扰）；其余档位与 proxy-v2 均为 100%
- p50/p95/p99: c120 proxy-v2 p95=2041.582ms（低于 proxy 的 2253.829ms）；c160 proxy-v2 p95=2799.838ms（低于 proxy 的 2955.541ms）
- cpu/mem: proxy-v2 CPU 均值约 3.18~3.36%，RSS 均值约 20.56~23.61MB；proxy CPU 均值约 2.28~2.30%，RSS 均值约 27.77~28.11MB（c120/c160）
- reconnect/errors: c80 proxy 出现大量 `127.0.0.1:7788` 连接失败，判定为代理启动就绪窗口问题
结论：CPU/RSS 指标链路可用；需要修复“客户端启动后立即压测”导致的假失败，保证基线稳定
是否回滚：否
```

```text
日期：2026-05-06
负责人：AI
改动项：压测脚本新增代理就绪等待（启动后先探测可用再进入 warmup/benchmark）
影响范围：apps/go/benchmark_go_clientcore_modes.sh（wait_proxy_ready + --startup-wait-sec）
压测命令：./benchmark_go_clientcore_modes.sh --profile smoke --requests 120 --modes proxy --kill-listeners --success-threshold 99 --p95-threshold-ms 8000
结果（前 -> 后）：
- success_rate: proxy c40/c80 均恢复到 100%
- p50/p95/p99: c40=641.73/693.252/713.175ms；c80=1290.342/1404.358/1415.026ms
- cpu/mem: c40 cpu_avg=2.1% rss_avg=18.255MB；c80 cpu_avg=1.833% rss_avg=20.49MB
- reconnect/errors: 无请求级错误
结论：已消除启动窗口带来的假失败，后续梯度/长稳数据可直接用于优化验收
是否回滚：否
```

```text
日期：2026-05-06
负责人：AI
改动项：修复后完整 gradient 基线复测（作为当前优化阶段对比基线）
影响范围：apps/go/benchmarks_go/20260506_102011（结果）
压测命令：./benchmark_go_clientcore_modes.sh --profile gradient --success-threshold 99 --p95-threshold-ms 8000 --kill-listeners
结果（前 -> 后）：
- success_rate: proxy/proxy-v2 在 c=80/120/160 均为 100%
- p50/p95/p99:
  - c80: proxy=1264.033/1743.51/1844.665ms；v2=1249.543/1962.594/2032.029ms
  - c120: proxy=1886.14/2170.434/2211.097ms；v2=1929.366/2479.599/2526.672ms
  - c160: proxy=2508.679/2719.061/2798.834ms；v2=2483.697/2814.96/2864.353ms
- cpu/mem:
  - c120/c160: v2 RSS 均值约 23.286~25.302MB（低于 proxy 的 28.589~31.075MB）
  - c80/c120/c160: v2 CPU 均值约 3.156~3.778%（高于 proxy 的 1.711~2.489%）
- reconnect/errors: 无请求级错误；日志中的 `Terminated: 15` 为脚本主动结束客户端进程
结论：当前优化后链路稳定性达标（100%）；v2 在内存占用上有优势，但 CPU 与尾延迟仍有继续优化空间
是否回滚：否
```

```text
日期：2026-05-06
负责人：AI
改动项：mux 自适应 flush（按待 flush 字节阈值与最大延迟触发，减少无效唤醒）
影响范围：apps/go/pkg/clientcore/core.go（sendFrame/flushBuffered/start 流程）
压测命令：./benchmark_go_clientcore_modes.sh --profile smoke --requests 200 --modes proxy-v2 --kill-listeners --success-threshold 99 --p95-threshold-ms 8000
结果（前 -> 后）：
- success_rate: proxy-v2 在 c40/c80 均为 100%
- p50/p95/p99: c40=617.776/749.923/965.414ms；c80=1246.37/1371.988/1390.961ms
- cpu/mem: c40 cpu_avg=2.925% rss_avg=17.633MB；c80 cpu_avg=2.6% rss_avg=18.785MB
- reconnect/errors: 无请求级错误；`Terminated: 15` 为脚本主动结束客户端进程
结论：自适应 flush 已稳定落地且无回归；下一步需在 gradient 全量对照下验证 CPU 与尾延迟改善幅度
是否回滚：否
```

```text
日期：2026-05-06
负责人：AI
改动项：自适应 flush 后完整 gradient 对照复测
影响范围：apps/go/benchmarks_go/20260506_102551（结果）；对照基线 apps/go/benchmarks_go/20260506_102011
压测命令：./benchmark_go_clientcore_modes.sh --profile gradient --success-threshold 99 --p95-threshold-ms 8000 --kill-listeners
结果（前 -> 后）：
- success_rate: proxy/proxy-v2 在 c=80/120/160 均为 100%
- p50/p95/p99（关注 proxy-v2）:
  - c80: p95 1962.594 -> 1409.191（改善）；p99 2032.029 -> 2108.53（轻微回退）
  - c120: p95 2479.599 -> 2285.428（改善）；p99 2526.672 -> 2468.978（改善）
  - c160: p95 2814.96 -> 2787.824（小幅改善）；p99 2864.353 -> 3090.59（回退）
- cpu/mem（proxy-v2）: CPU 均值约 3.0~3.522%；RSS 均值约 21.731~23.486MB（仍显著低于 proxy）
- reconnect/errors: 无请求级错误；`Terminated: 15` 为脚本主动结束客户端进程
结论：自适应 flush 对 p95 有正向收益（尤其 c80/c120），但 p99 在部分档位波动；建议下一步做“写锁竞争与 flush 通知抖动”专项优化
是否回滚：否
```

```text
日期：2026-05-06
负责人：AI
改动项：flush 循环降竞争（仅在 pending 数据存在时才进入 flush，减少写锁空竞争）
影响范围：apps/go/pkg/clientcore/core.go（startFlushLoop/sendFrame/flushBuffered）
压测命令：./benchmark_go_clientcore_modes.sh --profile smoke --requests 200 --modes proxy-v2 --kill-listeners --success-threshold 99 --p95-threshold-ms 8000
结果（前 -> 后）：
- success_rate: proxy-v2 在 c40/c80 均为 100%
- p50/p95/p99: c40=619.567/821.858/966.209ms；c80=1248.26/1406.308/1608.834ms
- cpu/mem: c40 cpu_avg=3.7% rss_avg=18.055MB；c80 cpu_avg=3.225% rss_avg=19.145MB
- reconnect/errors: 无请求级错误；`Terminated: 15` 为脚本主动结束客户端进程
结论：无回归；flush 空竞争已降低，下一步需在 gradient 全量对照中评估 p99 抖动是否收敛
是否回滚：否
```

```text
日期：2026-05-06
负责人：AI
改动项：flush 降竞争后完整 gradient 对照复测
影响范围：apps/go/benchmarks_go/20260506_102938（结果）；对照上一轮 apps/go/benchmarks_go/20260506_102551
压测命令：./benchmark_go_clientcore_modes.sh --profile gradient --success-threshold 99 --p95-threshold-ms 8000 --kill-listeners
结果（前 -> 后）：
- success_rate: proxy/proxy-v2 在 c=80/120/160 均为 100%
- p50/p95/p99（关注 proxy-v2，对比 102551）:
  - c80: p95 1409.191 -> 1512.943（回退）；p99 2108.53 -> 1639.603（改善）
  - c120: p95 2285.428 -> 2339.883（小幅回退）；p99 2468.978 -> 2954.03（回退）
  - c160: p95 2787.824 -> 2721.284（改善）；p99 3090.59 -> 2817.639（改善）
- cpu/mem（proxy-v2）: CPU 均值约 2.956~3.633%；RSS 均值约 22.061~25.439MB（仍显著低于 proxy）
- reconnect/errors: 无请求级错误；`Terminated: 15` 为脚本主动结束客户端进程
结论：优化保持稳定（100%），但 p95/p99 仍存在档位波动；建议进行至少 3 轮重复测取中位值，再判断是否继续调整 flush 参数
是否回滚：否
```

```text
日期：2026-05-06
负责人：AI
改动项：压测脚本支持重复执行与中位值报告（--repeat）
影响范围：apps/go/benchmark_go_clientcore_modes.sh
压测命令：./benchmark_go_clientcore_modes.sh --profile smoke --repeat 2 --requests 80 --modes proxy-v2 --kill-listeners --success-threshold 99 --p95-threshold-ms 8000
结果（前 -> 后）：
- success_rate: repeat=2 下 c40/c80 均为 100%
- p50/p95/p99: 已支持多轮采样，新增 compare_median.md / verdict_median.md 输出中位值
- cpu/mem: 已纳入中位值汇总（cpu_avg_med / rss_avg_med）
- reconnect/errors: 无请求级错误；`Terminated: 15` 为脚本主动结束客户端进程
结论：已具备“重复压测 + 中位值决策”能力，可减少单轮波动对结论的干扰
是否回滚：否
```

```text
日期：2026-05-06
负责人：AI
改动项：TLS 参数优化（启用 Go 客户端 TLS 会话缓存，新增 upstream_tls_session_cache_size 默认 256）
影响范围：apps/go/pkg/clientcore/core.go, apps/go/config/client.example.json, apps/go/gui/app.go
压测命令：./benchmark_go_clientcore_modes.sh --profile smoke --requests 200 --modes proxy-v2 --kill-listeners --success-threshold 99 --p95-threshold-ms 8000
结果（前 -> 后）：
- success_rate: proxy-v2 在 c40/c80 均为 100%
- p50/p95/p99: c40=622.236/700.661/741.145ms；c80=1203.385/1366.757/1379.147ms
- cpu/mem: c40 cpu_avg=2.775% rss_avg=17.383MB；c80 cpu_avg=3.85% rss_avg=18.938MB
- reconnect/errors: 无请求级错误；`Terminated: 15` 为脚本主动结束客户端进程
结论：TLS 会话缓存改动已稳定落地；短测无回归，后续可通过 repeat=3 的 gradient 中位值进一步量化握手开销收益
是否回滚：否
```

```text
日期：2026-05-06
负责人：AI
改动项：TLS 会话缓存改动后的 repeat=3 gradient 中位值验收
影响范围：apps/go/benchmarks_go/20260506_103716（compare_median.md / verdict_median.md）
压测命令：./benchmark_go_clientcore_modes.sh --profile gradient --repeat 3 --success-threshold 99 --p95-threshold-ms 8000 --kill-listeners
结果（前 -> 后）：
- success_rate: proxy/proxy-v2 在 c=80/120/160 中位值均为 100%
- p95 中位值: c80 v2=1497.322（优于 proxy 1527.108）；c120 v2=2132.129（与 proxy 2129.806 基本持平）；c160 v2=2681.762（优于 proxy 2745.438）
- p99 中位值: c120/c160 v2 分别为 2200.875/2792.306，均显著优于 proxy 的 2771.646/3594.752；c80 v2 为 1835.882，略高于 proxy 的 1807.885
- cpu/mem 中位值: v2 CPU 高于 proxy（约 +0.8~1.3%），但 RSS 显著更低（约 -4~7MB）
结论（历史）：repeat=3 中位值下，v2 在当时环境下表现更优。当前主路径决策已收敛为 `/proxy`，此结论仅用于回溯。
是否回滚：否
```

```text
日期：2026-05-06
负责人：AI
改动项：sendFrame 热路径降开销（每帧 atomic 计数改为状态翻转 hasPendingFlush，仅在 0->有数据/flush 后清零时更新）
影响范围：apps/go/pkg/clientcore/core.go（mux sendFrame/startFlushLoop/flushBuffered）
压测命令：./benchmark_go_clientcore_modes.sh --profile smoke --repeat 2 --requests 120 --modes proxy-v2 --kill-listeners --success-threshold 99 --p95-threshold-ms 8000
结果（前 -> 后）：
- success_rate: c40/c80 中位值均为 100%
- p50/p95/p99: c40=625.364/737.563/750.624ms；c80=1257.505/1350.385/1370.527ms
- cpu/mem: c40 cpu_avg_med=4.05% rss_avg_med=16.773MB；c80 cpu_avg_med=2.7% rss_avg_med=17.794MB
- reconnect/errors: 无请求级错误；仅测试 v2 模式，verdict_median 为 INCOMPLETE 属预期
结论：改动稳定无回归；已减少热路径原子操作频率，CPU 优化趋势需在 repeat=3 的 gradient 全量对照下确认
是否回滚：否
```

```text
日期：2026-05-06
负责人：AI
改动项：sendFrame 热路径降开销后的 repeat=3 gradient 中位值验收
影响范围：apps/go/benchmarks_go/20260506_104452（compare_median.md / verdict_median.md）
压测命令：./benchmark_go_clientcore_modes.sh --profile gradient --repeat 3 --success-threshold 99 --p95-threshold-ms 8000 --kill-listeners
结果（前 -> 后）：
- success_rate: proxy/proxy-v2 在 c=80/120/160 中位值均为 100%
- p95 中位值: c80 v2=1521.596（优于 proxy 1559.666）；c120 v2=2238.998（劣于 proxy 2149.666）；c160 v2=2870.475（劣于 proxy 2833.236）
- p99 中位值: c80/c120/c160 v2=1707.542/2408.354/3157.64，其中 c120/c160 相比 proxy 存在回退
- cpu/mem 中位值: v2 CPU 约 3.11/3.156/3.278%，较 proxy 2.244/1.856/2.244 偏高；RSS 仍显著更低（约 -3.8MB~-6.8MB）
结论：该优化在全量中位值口径下未体现稳定收益（尤其 c120/c160 尾延迟回退）；建议暂不继续沿此方向调参，优先考虑回滚该变更并转向连接/调度层优化
是否回滚：建议回滚（待确认）
```

```text
日期：2026-05-06
负责人：AI
改动项：回滚 sendFrame 热路径 hasPendingFlush 实验改动并做 repeat=3 gradient 复核
影响范围：apps/go/pkg/clientcore/core.go；apps/go/benchmarks_go/20260506_105007（compare_median.md / verdict_median.md）
压测命令：./benchmark_go_clientcore_modes.sh --profile gradient --repeat 3 --success-threshold 99 --p95-threshold-ms 8000 --kill-listeners
结果（前 -> 后）：
- success_rate: proxy/proxy-v2 在 c=80/120/160 中位值均为 100%
- p95 中位值（回滚后 v2）: c80=1600.807（较回滚前 1521.596 回退）；c120=2136.652（较回滚前 2238.998 改善）；c160=2696.214（较回滚前 2870.475 明显改善）
- p99 中位值（回滚后 v2）: c80=1866.016（较回滚前 1707.542 回退）；c120=2637.28（较回滚前 2408.354 回退）；c160=2832.557（较回滚前 3157.64 改善）
- cpu/mem 中位值（回滚后 v2）: CPU 约 3.611/3.111/3.189%，RSS 约 22.224/23.536/24.163MB
结论：回滚后在中高并发（c120/c160）的 p95 明显更稳，但 c80 与部分 p99 仍有波动；建议保持当前回滚版本，后续优化转向连接调度策略而非热路径原子逻辑
是否回滚：是（已执行）
```

```text
日期：2026-05-06
负责人：AI
改动项：flush 通知合并（drain flushNotify，合并突发通知，减少重复唤醒）
影响范围：apps/go/pkg/clientcore/core.go（startFlushLoop notify 分支）
压测命令：./benchmark_go_clientcore_modes.sh --profile smoke --repeat 2 --requests 120 --modes proxy-v2 --kill-listeners --success-threshold 99 --p95-threshold-ms 8000
结果（前 -> 后）：
- success_rate: c40/c80 中位值均为 100%
- p50/p95/p99: c40=609.986/794.566/962.056ms；c80=1157.698/1328.633/1341.422ms
- cpu/mem: c40 cpu_avg_med=3.716% rss_avg_med=16.834MB；c80 cpu_avg_med=3.734% rss_avg_med=17.88MB
- reconnect/errors: 无请求级错误；仅测试 v2 模式，verdict_median 为 INCOMPLETE 属预期
结论：通知合并改动稳定无回归；在 smoke 口径下尾延迟有改善迹象，建议下一步用 repeat=3 的 gradient 全量对照确认
是否回滚：否
```

```text
日期：2026-05-06
负责人：AI
改动项：flush 通知合并后的 repeat=3 gradient 全量验收
影响范围：apps/go/benchmarks_go/20260506_105650（compare_median.md / verdict_median.md）
压测命令：./benchmark_go_clientcore_modes.sh --profile gradient --repeat 3 --success-threshold 99 --p95-threshold-ms 8000 --kill-listeners
结果（前 -> 后）：
- success_rate: proxy/proxy-v2 在 c=80/120/160 中位值均为 100%
- p95 中位值: c80 v2=1552.437（劣于 proxy 1389.324）；c120 v2=2194.778（劣于 proxy 2155.89）；c160 v2=2678.264（优于 proxy 2806.021）
- p99 中位值: c80/c120 v2=1737.145/2487.227（略劣于 proxy 1715.303/2450.987）；c160 v2=2906.502（优于 proxy 3265.173）
- cpu/mem 中位值: v2 CPU 约 3.633/3.7/3.278%，仍高于 proxy；RSS 约 21.672/23.377/24.958MB，显著低于 proxy
结论：该优化在全量中位值口径下收益不一致（仅 c160 明显受益）；建议保持代码稳定，暂不继续放大此方向改动，后续转向更可控的参数分档策略
是否回滚：暂不回滚（可保留）
```

```text
日期：2026-05-06
负责人：AI
改动项：mux 参数分档策略（latency/balanced/throughput）+ 可选细粒度覆盖参数
影响范围：apps/go/pkg/clientcore/core.go, apps/go/config/client.example.json
压测命令：./benchmark_go_clientcore_modes.sh --profile smoke --repeat 2 --requests 120 --modes proxy-v2 --kill-listeners --success-threshold 99 --p95-threshold-ms 8000
结果（前 -> 后）：
- success_rate: c40/c80 中位值均为 100%
- p50/p95/p99: c40=625.417/831.281/1027.764ms；c80=1305.936/1459.061/1471.072ms
- cpu/mem: c40 cpu_avg_med=2.567% rss_avg_med=16.857MB；c80 cpu_avg_med=3.4% rss_avg_med=17.495MB
- reconnect/errors: 无请求级错误；仅测试 v2 模式，verdict_median 为 INCOMPLETE 属预期
结论：参数分档能力已落地且默认保持 balanced 行为；可在后续 gradient repeat=3 中按分档横向对比，选择更适合当前网络环境的默认档
是否回滚：否
```

```text
日期：2026-05-06
负责人：AI
改动项：mux 三档参数横向验收（latency/balanced/throughput，均执行 gradient + repeat=3）
影响范围：apps/go/benchmarks_go/profile_latency_20260506, apps/go/benchmarks_go/profile_balanced_20260506, apps/go/benchmarks_go/profile_throughput_20260506
压测命令：./benchmark_go_clientcore_modes.sh --profile gradient --repeat 3 --success-threshold 99 --p95-threshold-ms 8000 --kill-listeners --out <dir>
结果（前 -> 后）：
- success_rate: 三档在 c80/c120/c160 下 proxy/proxy-v2 中位值均为 100%
- p95（proxy-v2 中位值）: latency=1406.115/2232.192/2641.078；balanced=1433.835/2097.945/2678.913；throughput=1419.425/2360.751/2732.473（对应 c80/c120/c160）
- p99（proxy-v2 中位值）: latency=1657.073/2445.859/3056.456；balanced=1646.141/2573.537/2892.663；throughput=1491.917/2740.315/2987.059
- cpu/mem（proxy-v2 中位值）: latency CPU 4.622~4.844% 内存 21.995~24.46MB；balanced CPU 3.078~3.433% 内存 20.356~24.786MB；throughput CPU 2.556~2.9% 内存 21.931~24.524MB
结论：balanced 作为默认档更稳妥（c120 p95 最优且 CPU 显著低于 latency）；throughput CPU 最低但 c120/c160 尾延迟波动偏大；latency 在 c160 p95 有优势但 CPU 成本最高。当前建议默认保持 balanced，按场景再切换 latency/throughput
是否回滚：否
```

```text
日期：2026-05-06
负责人：AI
改动项：balanced 档 streamDataQueue 试调（8 -> 12）并做 repeat=3 gradient 验收
影响范围：apps/go/pkg/clientcore/core.go；apps/go/benchmarks_go/profile_balanced_q12_20260506
压测命令：./benchmark_go_clientcore_modes.sh --profile gradient --repeat 3 --success-threshold 99 --p95-threshold-ms 8000 --kill-listeners --out apps/go/benchmarks_go/profile_balanced_q12_20260506
结果（前 -> 后）：
- success_rate: c80/c120/c160 下 proxy/proxy-v2 中位值均为 100%
- p95（proxy-v2，中位值）: c80 1433.835 -> 1569.718（回退）；c120 2097.945 -> 2142.722（小幅回退）；c160 2678.913 -> 2964.558（明显回退）
- p99（proxy-v2，中位值）: c80 1646.141 -> 1861.453（回退）；c120 2573.537 -> 2367.188（改善）；c160 2892.663 -> 3269.572（明显回退）
- cpu/mem（proxy-v2，中位值）: CPU c80/c160 略升、c120 略升；RSS 基本持平
结论：该调参在中高并发稳定性口径下收益不一致且回退更明显（尤其 c160），不适合保留
是否回滚：是（已回滚到 streamDataQueue=8）
```

```text
日期：2026-05-06
负责人：AI
改动项：balanced 档 flush 参数小步快筛（smoke+repeat=2，仅 proxy-v2）
影响范围：apps/go/benchmarks_go/tune_smoke_base_20260506, apps/go/benchmarks_go/tune_smoke_a_20260506, apps/go/benchmarks_go/tune_smoke_b_20260506, apps/go/benchmarks_go/tune_smoke_c_20260506
压测命令：./benchmark_go_clientcore_modes.sh --profile smoke --repeat 2 --modes proxy-v2 --success-threshold 99 --p95-threshold-ms 8000 --kill-listeners --out <dir>
结果（前 -> 后）：
- baseline（默认 balanced）: c40 p95/p99=822.235/919.106ms；c80 p95/p99=1392.809/1466.591ms；cpu=3.266%/3.075%
- 候选A（notify=2048, burst=16384）: c40 p95/p99=717.704/789.113 改善，但 c80 p95/p99=1561.514/1728.077 明显回退，CPU 更高
- 候选B（notify=6144, burst=32768）: c40/c80 的 p95/p99 均回退（c40 p95=1004.853；c80 p95=1452.152）
- 候选C（max_delay_ms=3）: c40 p95 改善到 757.239，但 c80 p95/p99 回退到 1548.689/1711.854
结论：候选参数均未在 c40/c80 同时稳定优于 baseline，不进入 gradient 全量；默认 balanced 参数保持不变
是否回滚：是（client.json 已恢复到干净 balanced，仅保留 mux_tuning_profile）
```

```text
日期：2026-05-06
负责人：AI
改动项：连接层参数快筛（upstream_max_conns_per_host: 0 -> 256，smoke+repeat=2，仅 proxy-v2）
影响范围：apps/go/benchmarks_go/tune_conn_base_20260506, apps/go/benchmarks_go/tune_conn_256_20260506
压测命令：./benchmark_go_clientcore_modes.sh --profile smoke --repeat 2 --modes proxy-v2 --success-threshold 99 --p95-threshold-ms 8000 --kill-listeners --out <dir>
结果（前 -> 后）：
- baseline(0): c40 p95/p99=747.022/923.132ms；c80 p95/p99=1503.598/1552.531ms；cpu=3.733%/3.466%
- 候选(256): c40 p95/p99=822.304/931.064ms；c80 p95/p99=1561.521/1868.561ms；cpu=3.458%/3.133%
- success_rate: 两组 c40/c80 中位值均为 100%
结论：`256` 虽有轻微 CPU 下降，但 c40/c80 尾延迟均回退（尤其 c80 p99 明显变差），不进入 gradient 全量
是否回滚：是（恢复 `upstream_max_conns_per_host=0`）
```

```text
日期：2026-05-06
负责人：AI
改动项：连接层参数快筛（upstream_h2_read_idle_timeout_ms: 30000 -> 45000，smoke+repeat=2，仅 proxy-v2）
影响范围：apps/go/benchmarks_go/tune_h2idle_base_20260506, apps/go/benchmarks_go/tune_h2idle_45000_20260506
压测命令：./benchmark_go_clientcore_modes.sh --profile smoke --repeat 2 --modes proxy-v2 --success-threshold 99 --p95-threshold-ms 8000 --kill-listeners --out <dir>
结果（前 -> 后）：
- baseline(30000): c40 p95/p99=782.832/855.856ms；c80 p95/p99=1342.941/1576.415ms；cpu=3.625%/3.484%
- 候选(45000): c40 p95/p99=833.083/955.678ms；c80 p95/p99=1544.041/1660.351ms；cpu=3.383%/3.225%
- success_rate: 两组 c40/c80 中位值均为 100%
结论：`45000` 在 c40/c80 的尾延迟均回退，虽然 CPU 略降但不满足稳定性优先原则，不进入 gradient 全量
是否回滚：是（恢复 `upstream_h2_read_idle_timeout_ms=30000`）
```

```text
日期：2026-05-06
负责人：AI
改动项：连接层参数试调（upstream_h2_ping_timeout_ms: 10000 -> 15000），先 smoke 再 gradient 全量验收
影响范围：apps/go/benchmarks_go/tune_h2ping_base_20260506, apps/go/benchmarks_go/tune_h2ping_15000_20260506, apps/go/benchmarks_go/tune_h2ping_grad_base_20260506, apps/go/benchmarks_go/tune_h2ping_grad_15000_20260506
压测命令：./benchmark_go_clientcore_modes.sh --profile smoke|gradient --repeat 2|3 --success-threshold 99 --p95-threshold-ms 8000 --kill-listeners --out <dir>
结果（前 -> 后）：
- smoke（仅 v2）: `15000` 在 c40/c80 的 p95/p99 相比 `10000` 有改善，进入 gradient
- gradient（repeat=3，中位值，关注 v2）:
  - c80: p95 1507.328 -> 1534.879（回退），p99 1790.867 -> 1820.023（回退）
  - c120: p95 2317.28 -> 2047.405（改善），p99 2693.445 -> 2170.149（改善）
  - c160: p95 2672.203 -> 2710.95（回退），p99 2721.505 -> 3051.545（明显回退）
- success_rate: baseline/candidate 在 c80/c120/c160 下 proxy/proxy-v2 中位值均为 100%
结论：`15000` 收益集中在 c120，但 c80/c160 尤其 c160 p99 回退明显，综合稳定性不满足保留标准
是否回滚：是（恢复 `upstream_h2_ping_timeout_ms=10000`）
```

```text
日期：2026-05-06
负责人：AI
改动项：S1 服务端 mux 出站队列优化（`Array.shift()` -> 数组头指针环形队列 + 条件压缩）
影响范围：apps/node/src/server.js（handleProxyV2MuxStream 的 outboundQueue 路径）
压测命令：node --check apps/node/src/server.js（已通过）；性能压测待部署到服务端后执行 gradient+repeat=3
结果（前 -> 后）：
- success_rate: 待补（需服务端部署后采集）
- p50/p95/p99: 待补
- cpu/mem: 待补
- reconnect/errors: 待补
结论：已完成低风险实现，协议行为保持不变，目标是降低高并发队列弹出开销；下一步进入部署后 A/B 验收
是否回滚：否
```

```text
日期：2026-05-06
负责人：AI
改动项：S2 服务端 mux flush 策略优化（字节阈值 + 最长延迟；控制帧优先立即 flush）
影响范围：apps/node/src/server.js, apps/node/config/server.json, apps/node/config/server.local.json, apps/node/config/server.example.json
压测命令：node --check apps/node/src/server.js（已通过）；性能压测待部署到服务端后执行 gradient+repeat=3
结果（前 -> 后）：
- success_rate: 待补（需服务端部署后采集）
- p50/p95/p99: 待补
- cpu/mem: 待补
- reconnect/errors: 待补
结论：已完成低风险实现，默认参数为 `muxFlushNotifyBytes=4096`、`muxFlushMaxDelayMs=2`；协议行为保持不变，目标是减少小包写与事件循环抖动
是否回滚：否
```

```text
日期：2026-05-06
负责人：AI
改动项：S3 服务端 mux 帧解析路径优化（去除 header 回插逻辑 + payload 优先零拷贝读取）
影响范围：apps/node/src/server.js（handleProxyV2MuxStream 的 incoming 解析路径）
压测命令：node --check apps/node/src/server.js（已通过）；性能压测待部署到服务端后执行 gradient+repeat=3
结果（前 -> 后）：
- success_rate: 待补（需服务端部署后采集）
- p50/p95/p99: 待补
- cpu/mem: 待补
- reconnect/errors: 待补
结论：已完成低风险实现，协议与帧格式保持不变；目标是减少入站帧解析过程中的内存拷贝与数组碎片操作
是否回滚：否
```

```text
日期：2026-05-06
负责人：AI
改动项：S4 服务端 backpressure 分档水位（高/低水位 hysteresis，降低 pause/resume 抖动）
影响范围：apps/node/src/server.js, apps/node/config/server.json, apps/node/config/server.local.json, apps/node/config/server.example.json
压测命令：node --check apps/node/src/server.js（已通过）；性能压测待部署到服务端后执行 gradient+repeat=3
结果（前 -> 后）：
- success_rate: 待补（需服务端部署后采集）
- p50/p95/p99: 待补
- cpu/mem: 待补
- reconnect/errors: 待补
结论：已完成低风险实现，默认参数为 `muxBackpressureHighWaterBytes=4194304`、`muxBackpressureLowWaterBytes=2097152`；协议行为保持不变，目标是降低高并发下 backpressure 抖动
是否回滚：否
```

```text
日期：2026-05-06
负责人：AI
改动项：S1~S4 服务端优化部署后验收（gradient + repeat=3）
影响范围：apps/go/benchmarks_go/server_s1_s4_postdeploy_20260506；对照基线 apps/go/benchmarks_go/profile_balanced_20260506
压测命令：./benchmark_go_clientcore_modes.sh --profile gradient --repeat 3 --success-threshold 99 --p95-threshold-ms 8000 --kill-listeners --out apps/go/benchmarks_go/server_s1_s4_postdeploy_20260506
结果（前 -> 后，关注 proxy-v2 中位值）：
- success_rate: c80/c120/c160 均为 100%（proxy 与 v2）
- c80: p95 1433.835 -> 1578.67（回退），p99 1646.141 -> 1824.238（回退）
- c120: p95 2097.945 -> 2146.332（小幅回退），p99 2573.537 -> 2444.912（改善）
- c160: p95 2678.913 -> 2908.512（明显回退），p99 2892.663 -> 3314.218（明显回退）
- cpu/mem: v2 CPU 3.344/3.433/3.078 -> 3.189/3.211/3.344；RSS 20.356/23.302/24.786 -> 21.694/23.281/23.398MB
结论：S1~S4 合并后稳定性（成功率）达标，但尾延迟收益不稳定，当前口径下不满足“可确认提升”；建议进入二分验证（优先回滚 S4，再看 S3）定位回退来源
是否回滚：待确认（建议先临时回滚 S4 做 A/B）
```

```text
日期：2026-05-06
负责人：AI
改动项：S4 回退后的有效验收（你已部署后执行；S1~S3 保留）
影响范围：apps/go/benchmarks_go/server_s1_s3_postdeploy_valid_20260506；对照 apps/go/benchmarks_go/server_s1_s4_postdeploy_20260506
压测命令：./benchmark_go_clientcore_modes.sh --profile gradient --repeat 3 --success-threshold 99 --p95-threshold-ms 8000 --kill-listeners --out apps/go/benchmarks_go/server_s1_s3_postdeploy_valid_20260506
结果（前 -> 后，前=S1~S4，后=S1~S3，关注 proxy-v2 中位值）：
- success_rate: c80/c120/c160 均为 100%（proxy 与 v2）
- c80: p95 1578.67 -> 1518.253（改善），p99 1824.238 -> 1732.157（改善）
- c120: p95 2146.332 -> 2202.506（回退），p99 2444.912 -> 2366.406（改善）
- c160: p95 2908.512 -> 2681.491（明显改善），p99 3314.218 -> 3318.143（基本持平）
- cpu/mem(v2): CPU 3.189/3.211/3.344 -> 3.033/3.2/3.044；RSS 21.694/23.281/23.398 -> 21.931/23.061/24.444MB
结论：在“已部署后有效数据”口径下，回滚 S4 后整体更稳，尤其 c160 p95 改善明显；建议保持 S4 回滚状态，下一步再评估是否对 S3 做二分
是否回滚：是（S4 已回滚并通过部署后验收）
```

```text
日期：2026-05-06
负责人：AI
改动项：S3 二分验收（你已部署后执行；对比 S1~S3 与 S1~S2）
影响范围：apps/go/benchmarks_go/server_s1_s2_postdeploy_valid_20260506；对照 apps/go/benchmarks_go/server_s1_s3_postdeploy_valid_20260506
压测命令：./benchmark_go_clientcore_modes.sh --profile gradient --repeat 3 --success-threshold 99 --p95-threshold-ms 8000 --kill-listeners --out apps/go/benchmarks_go/server_s1_s2_postdeploy_valid_20260506
结果（前 -> 后，前=S1~S3，后=S1~S2，关注 proxy-v2 中位值）：
- success_rate: c80/c120/c160 均为 100%（proxy 与 v2）
- c80: p95 1518.253 -> 1449.148（改善），p99 1732.157 -> 1773.875（小幅回退）
- c120: p95 2202.506 -> 2137.034（改善），p99 2366.406 -> 2401.292（小幅回退）
- c160: p95 2681.491 -> 3282.43（明显回退），p99 3318.143 -> 3431.856（回退）
- cpu/mem(v2): CPU 3.033/3.2/3.044 -> 3.233/3.156/3.12；RSS 21.931/23.061/24.444 -> 21.866/22.969/24.146MB
结论：S3 回退后在 c80/c120 有局部收益，但 c160 尾延迟明显劣化；按稳定优先口径，建议保留 S3（不回滚）
是否回滚：否（S3 保留）
```

```text
日期：2026-05-06
负责人：AI
改动项：S2 二分验收（你已部署后执行；对比 S1~S2~S3 与 S1~S3）
影响范围：apps/go/benchmarks_go/server_s1_s3_no_s2_postdeploy_valid_20260506；对照 apps/go/benchmarks_go/server_s1_s3_postdeploy_valid_20260506
压测命令：./benchmark_go_clientcore_modes.sh --profile gradient --repeat 3 --success-threshold 99 --p95-threshold-ms 8000 --kill-listeners --out apps/go/benchmarks_go/server_s1_s3_no_s2_postdeploy_valid_20260506
结果（前 -> 后，前=S1~S2~S3，后=S1~S3，关注 proxy-v2 中位值）：
- success_rate: c80/c120/c160 均为 100%（proxy 与 v2）
- c80: p95 1518.253 -> 1415.616（改善），p99 1732.157 -> 1494.898（改善）
- c120: p95 2202.506 -> 2032.217（改善），p99 2366.406 -> 2542.577（回退）
- c160: p95 2681.491 -> 2779.87（回退），p99 3318.143 -> 3334.856（小幅回退）
- cpu/mem(v2): CPU 3.2/3.044 -> 3.3/3.367；RSS 23.061/24.444 -> 23.347/25.179MB（c120/c160）
结论：回退 S2 在低并发有收益，但中高并发（尤其 c160）尾延迟与 CPU 有回退；按稳定优先口径建议保留 S2
是否回滚：否（S2 保留）
```

```text
日期：2026-05-06
负责人：AI
改动项：S1 二分验收（你已部署后执行；对比 S1~S2~S3 与 S2~S3）
影响范围：apps/go/benchmarks_go/server_s2_s3_no_s1_postdeploy_valid_20260506；对照 apps/go/benchmarks_go/server_s1_s3_postdeploy_valid_20260506
压测命令：./benchmark_go_clientcore_modes.sh --profile gradient --repeat 3 --success-threshold 99 --p95-threshold-ms 8000 --kill-listeners --out apps/go/benchmarks_go/server_s2_s3_no_s1_postdeploy_valid_20260506
结果（前 -> 后，前=S1~S2~S3，后=S2~S3，关注 proxy-v2 中位值）：
- success_rate: c80/c120/c160 均为 100%（proxy 与 v2）
- c80: p95 1518.253 -> 1513.845（基本持平），p99 1732.157 -> 1806.786（回退）
- c120: p95 2202.506 -> 2171.168（改善），p99 2366.406 -> 2292.024（改善）
- c160: p95 2681.491 -> 2722.195（小幅回退），p99 3318.143 -> 2987.772（明显改善）
- cpu/mem(v2): CPU 3.2/3.044 -> 3.467/3.289；RSS 23.061/24.444 -> 23.068/24.877MB（c120/c160）
结论：回退 S1 后 c120 与 c160 的尾延迟整体更优（尤其 c160 p99 明显改善），但 CPU 略升；按稳定优先与尾延迟权重，建议回滚 S1
是否回滚：是（建议保持 S1 回滚状态）
```

```text
日期：2026-05-06
负责人：AI
改动项：最终确认（全量 proxy + proxy-v2，S1 回滚 + S2/S3 保留 + S4 回滚）
影响范围：apps/go/benchmarks_go/server_final_confirm_s2_s3_20260506；对照 apps/go/benchmarks_go/server_s2_s3_no_s1_postdeploy_valid_20260506
压测命令：./benchmark_go_clientcore_modes.sh --profile gradient --repeat 3 --success-threshold 99 --p95-threshold-ms 8000 --kill-listeners --out apps/go/benchmarks_go/server_final_confirm_s2_s3_20260506
结果（观察项）：
- proxy-v2 success_rate: c80/c120/c160 中位值均为 100%
- proxy c160 出现单轮异常（repeat3 success_rate=68%，含 502/empty reply/SSL EOF），中位值未被拉低
- proxy-v2 中位值：c80 p95/p99=1720.325/2015.416，c120=2180.114/2351.19，c160=3001.448/3050.227
- 与上一轮同版本相比，结果存在明显环境波动，不宜单轮直接作为回滚判断依据
结论：全量复核通过阈值，但受单轮异常影响噪声偏大；需以 proxy-v2 专项复核作为最终确认依据
是否回滚：否（维持 S1 回滚 + S2/S3 保留）
```

```text
日期：2026-05-06
负责人：AI
改动项：最终确认补跑（proxy-v2 专项复核，排除 proxy 路径噪声）
影响范围：apps/go/benchmarks_go/server_final_confirm_s2_s3_v2rerun_20260506；对照 apps/go/benchmarks_go/server_s2_s3_no_s1_postdeploy_valid_20260506
压测命令：./benchmark_go_clientcore_modes.sh --profile gradient --repeat 3 --modes proxy-v2 --success-threshold 99 --p95-threshold-ms 8000 --kill-listeners --out apps/go/benchmarks_go/server_final_confirm_s2_s3_v2rerun_20260506
结果（前 -> 后，前=上一轮同版本，后=本轮复核，关注 proxy-v2 中位值）：
- success_rate: c80/c120/c160 均为 100%
- c80: p95 1513.845 -> 1492.79（改善），p99 1806.786 -> 1785.217（改善）
- c120: p95 2171.168 -> 2263.204（回退），p99 2292.024 -> 2446.959（回退）
- c160: p95 2722.195 -> 2775.47（小幅回退），p99 2987.772 -> 2962.669（小幅改善）
- cpu/mem(v2): CPU 3.467/3.289 -> 3.31/3.244；RSS 23.068/24.877 -> 23.372/24.854MB（c120/c160）
结论：在无代码改动下仍有场景波动，但中高并发趋势未推翻既有二分结论；维持最终方案：S1 回滚、S2/S3 保留、S4 回滚
是否回滚：否（最终方案不变）
```

```text
日期：2026-05-07
负责人：AI
改动项：proxy-only 链路可观测与体验稳定性优化（trace_id 贯通、慢日志限频、日志环形缓冲、视频域名首包超时开关）
影响范围：apps/go/pkg/clientcore/core.go, apps/go/gui/app.go, apps/go/gui/frontend/index.html, apps/node/src/server.js, apps/node/src/logger.js, apps/node/config/server*.json
压测命令：node --check apps/node/src/server.js && node --check apps/node/src/logger.js；go test ./pkg/clientcore/... ./gui/...
结果（前 -> 后）：
- success_rate: 待补（本次以可观测与兜底策略为主，需部署后按最小验收矩阵采集）
- p50/p95/p99: 待补
- cpu/mem: 预期日志风暴场景下更平稳（已通过慢日志限频 + O(1) 日志缓冲降低抖动）
- reconnect/errors: 新增 trace_id 贯通与 auth reason 透传，新增 video_first_byte_timeout 指标便于评估误杀与收益
结论：已完成低风险基础优化；下一步在真实视频拖动场景验证 `videoFirstByteTimeoutMs=3000` 的体感收益与副作用，再决定是否保留
是否回滚：待确认（按部署后验收结果）
```
