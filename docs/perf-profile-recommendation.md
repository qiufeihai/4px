# 4px Mux 分档选型建议

本文基于 `apps/go/benchmarks_go/profile_{latency|balanced|throughput}_20260506` 的 `gradient + repeat=3` 中位值结果。

## 结论

- 默认建议：`balanced`
- 原因：在当前网络环境下，`balanced` 在 `p95/p99` 与 CPU 成本之间整体最均衡。
- 备选建议：
  - `throughput`：CPU 更低，但中高并发尾延迟波动更大。
  - `latency`：部分并发档 `p95` 更好，但 CPU 成本最高。

## 快速对比（proxy-v2 中位值）

| profile | c80 p95 (ms) | c120 p95 (ms) | c160 p95 (ms) | c80 p99 (ms) | c120 p99 (ms) | c160 p99 (ms) | CPU 中位值范围 (%) | RSS 中位值范围 (MB) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| latency | 1406.115 | 2232.192 | 2641.078 | 1657.073 | 2445.859 | 3056.456 | 4.622 ~ 4.844 | 21.995 ~ 24.460 |
| balanced | 1433.835 | 2097.945 | 2678.913 | 1646.141 | 2573.537 | 2892.663 | 3.078 ~ 3.433 | 20.356 ~ 24.786 |
| throughput | 1419.425 | 2360.751 | 2732.473 | 1491.917 | 2740.315 | 2987.059 | 2.556 ~ 2.900 | 21.931 ~ 24.524 |

## 配置方法

在 `apps/go/config/client.json` 中设置：

```json
{
  "mux_tuning_profile": "balanced"
}
```

可选值：
- `latency`
- `balanced`
- `throughput`

## 何时切换

- 选 `throughput`：机器 CPU 紧张，且可以接受 `c120/c160` 下更高尾延迟波动。
- 选 `latency`：业务更看重延迟，且有余量承受更高 CPU。
- 保持 `balanced`：无明显单一瓶颈，追求默认稳态。
