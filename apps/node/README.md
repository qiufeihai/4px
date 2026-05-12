# 4px Node Agent

Node 版本的 `4px` 负责核心数据面，包含：
- `server`：基于 HTTP/2 隧道的正向代理服务端，接收 `TLS + HTTP/2` 请求并转发到目标地址。
- `client`：本地入口，提供 `SOCKS5` 与 `HTTP` 代理，再转发到远端 `server`。
- `bin/4px.js`：统一 CLI 入口，支持自动初始化默认配置。

当前默认主路径：`/proxy`。

## 核心特性

- 单路径数据面：当前版本固定 `POST /proxy`。
- 多用户鉴权：支持 `authTokens` 与 `server.users.json` 并行鉴权。
- 可观测与防护：支持 `trace_id`、慢建链统计、过载保护、DNS 缓存与短时熔断。
- 运维能力：支持 Web 管理端、systemd 部署、日志与资源观测。

## 目录说明

- `bin/4px.js`：命令入口（`server` / `client` / `help`）
- `src/server.js`：上游服务端
- `src/client.js`：本地客户端
- `TODO.md`：功能待办与规划
- `src/socks5.js`：SOCKS5 协议处理
- `src/config.js`：配置加载逻辑
- `src/run_cluster.js`：多进程 server 启动入口
- `config/*.json`：示例与本地调试配置
- `deploy_systemd_server.sh`：Linux systemd 部署脚本

## 前置要求

- Node.js 16+（建议 LTS）
- OpenSSL（用于测试证书）
- Linux 生产部署需 systemd（仅在使用部署脚本时需要）

## 快速开始

### 1. 安装

```bash
cd apps/node
npm install
```

### 2. 准备配置

方式 A（直接使用仓库内配置）：

```bash
cp config/server.example.json config/server.json
cp config/client.example.json config/client.json
cp config/server.users.example.json config/server.users.json
```

方式 B（用 CLI 在当前目录自动初始化）：

```bash
node bin/4px.js server
# 若当前目录缺少 server.json，会自动生成并提示先修改
```

### 3. 启动服务

```bash
# 启动 server
node bin/4px.js server -c config/server.json

# 启动 client（新终端）
node bin/4px.js client -c config/client.json
```

启动后默认本地代理入口：
- SOCKS5：`127.0.0.1:7777`
- HTTP：`127.0.0.1:7788`

## CLI 用法

```bash
4px server [-c config/server.json]
4px client [-c config/client.json]
4px help
```

说明：
- 未传 `-c` 时，默认在当前工作目录查找配置文件。
- `server` 默认查找 `./server.json`。
- `client` 默认查找 `./client.json`。
- 默认配置不存在时，会从模板自动复制到当前目录，然后退出并提示你先修改配置。

## 配置说明

### `server.json`

- `listenHost` / `listenPort`：监听地址与端口
- `tls.keyFile` / `tls.certFile`：TLS 私钥与证书
- `authTokens`：静态鉴权 token 列表（可与多用户并行生效）
- `authUsersFile`：多用户文件路径（启用后按用户 `authToken` 鉴权）
- `authUsersReloadIntervalMs`：用户文件热加载间隔
- `admin.enabled` / `admin.listenHost` / `admin.listenPort` / `admin.token`：Web 管理端配置（管理面默认独立子进程）
- `admin.serviceControl.enabled` / `admin.serviceControl.systemdService` / `admin.serviceControl.useSudo`：Web 触发 systemd 重启配置
- `admin.clientConfigExport.*`：用户 client 配置导出默认值（`upstreamHost/upstreamPort/serverName/rejectUnauthorized/caFile`）
- `logLevel`：日志等级（`DEBUG/INFO/WARN/ERROR`）
- `listenBacklog`：监听 backlog
- `maxBufferedBytes`：单连接写缓冲上限
- `metricsIntervalMs`：指标日志输出周期（默认 `60000ms`）
- `metricsReporter.enabled`：是否启用指标异步上报子进程（默认 `true`，主进程仅采样并 IPC 发送）
- `slowEstablishEnabled`：是否启用 `slow establish` 慢链路日志收集（默认 `false`；开启后输出慢日志与 summary）
- `slowEstablishTopN`：慢链路 summary 输出条数上限（默认 `5`）
- `slowEstablishSummaryIntervalMs`：慢链路 summary 输出周期（默认 `120000ms`，且不低于 `metricsIntervalMs`）
- `establishWarnThresholdMs`：建链慢日志阈值（毫秒，默认 `1500`，超过会打印 `slow establish` 警告）
- `establishWarnMinIntervalMs`：同目标慢建链日志最小间隔（毫秒，默认 `5000`，用于限频降噪）
- `remoteErrorLogMinIntervalMs`：`remote connection error` 同目标日志最小输出间隔（毫秒，默认 `3000`；`0` 表示不限制）
- `h2HeaderTableSize` / `h2InitialWindowSize` / `h2MaxConcurrentStreams` / `h2MaxFrameSize` / `h2MaxHeaderListSize`：HTTP/2 连接参数（默认值见配置文件，通常保持默认）
- `remoteConnectTimeoutMs`：到目标地址连接超时
- `remoteConnectMaxInFlight`：server 同时进行中的出站建连上限（默认 `4096`；超过会快速返回 `503`，用于抑制建连风暴）
- `remoteConnectMaxInFlightPerHost`：单目标主机（host:port）同时进行中的建连上限（默认 `1024`；用于隔离热点目标）
- `remoteConnectOverloadWaitMs`：过载时短暂等待可用建连槽的时长（毫秒，默认 `20`）
- `remoteConnectOverloadMaxWaiters`：允许进入短暂等待的并发请求上限（默认 `1024`）
- `remoteConnectOverloadLogMinIntervalMs`：过载拒绝日志最小输出间隔（毫秒，默认 `3000`；`0` 表示不限制）
- `remoteDnsCacheTtlMs`：DNS 正缓存 TTL（毫秒，默认 `60000`）
- `remoteDnsNegativeCacheTtlMs`：DNS 负缓存 TTL（毫秒，默认 `5000`）
- `remoteDnsCacheMaxEntries`：DNS 缓存最大条目数（默认 `4096`）
- `remoteCircuitFailureThreshold`：单目标连续建连失败触发熔断的阈值（默认 `8`）
- `remoteCircuitOpenMs`：熔断打开后拒绝时长（毫秒，默认 `15000`）
- `remoteCircuitLogMinIntervalMs`：熔断相关日志最小输出间隔（毫秒，默认 `3000`）
- `remoteCircuitMaxTargets`：熔断状态表最大目标数量（默认 `4096`）
- `remoteIdleTimeoutMs`：目标连接空闲超时（`0` 表示关闭）
- `remoteKeepAliveInitialDelayMs`：目标连接 KeepAlive 初始延迟
- `streamIdleTimeoutMs`：H2 stream 空闲超时（`0` 表示关闭）
- `defaultMaxDevices` / `deviceLeaseTtlMs` / `deviceLimitPolicy`：设备数限制策略
- `deviceTicket.enabled`：是否启用服务端签发设备票据（默认 `true`）
- `deviceTicket.secret`：设备票据签名密钥（必填，生产请使用高强度随机串）
- `deviceTicket.ttlMs`：设备票据有效期（毫秒）
- `deviceTicket.require`：是否要求请求走 `x-device-ticket` 设备票据校验（建议 `true`）
- `deviceLeaseStore.mode`：设备租约存储模式（`memory` 或 `redis`）
- `deviceLeaseStore.bindPeerIp`：设备识别是否绑定客户端源 IP（默认 `true`，防共享 token 伪造）
- `deviceLeaseStore.prefix`：Redis 模式下设备租约键前缀
- `deviceLeaseStore.redis.*`：Redis 连接参数（`enabled/url/password/database/connectTimeoutMs`）
- `deviceLeaseTouchMinIntervalMs`：同设备租约最小触达间隔（默认 `5000ms`，仅在 Redis 模式用于降低每请求 `eval` 频率）
- `camouflageRateLimit.windowMs/maxRequests`：伪装页 `GET /` 轻量限频（默认 `10s` 内每 IP 最多 `30` 次，超出返回 `429`；不影响 `/proxy`）

### 性能参数（建议重点）

- 建连并发：`remoteConnectMaxInFlight`、`remoteConnectMaxInFlightPerHost`
- 过载削峰：`remoteConnectOverloadWaitMs`、`remoteConnectOverloadMaxWaiters`、`remoteConnectOverloadLogMinIntervalMs`
- DNS 缓存：`remoteDnsCacheTtlMs`、`remoteDnsNegativeCacheTtlMs`、`remoteDnsCacheMaxEntries`
- 短时熔断：`remoteCircuitFailureThreshold`、`remoteCircuitOpenMs`
- 慢链路诊断：`slowEstablishEnabled`、`establishWarnThresholdMs`、`remoteErrorLogMinIntervalMs`

说明：
- 当前代码固定使用高性能默认：入站 socket 强制 `TCP_NODELAY + KeepAlive(30000ms)`；出站优先启用双栈自动建连；目标级短时熔断与伪装页限频始终开启，不再暴露对应开关参数。
- 若使用 `USE_CLUSTER=1` 且需要严格防作弊，建议启用 `deviceLeaseStore.mode=redis`，避免多 worker 内存状态分裂导致设备上限失真。
- 管理端口 `6688` 默认以独立子进程运行，降低对数据面事件循环的影响。

### `client.json`

- `socksListenHost` / `socksListenPort`：本地 SOCKS5 监听
- `httpListen` / `httpListenBacklog`：本地 HTTP 代理监听
- `upstream.host` / `upstream.port`：远端 server 地址
- `upstream.path`：历史兼容字段；当前运行时固定走 `/proxy`
- `upstream.serverName` / `upstream.authToken` / `upstream.rejectUnauthorized` / `upstream.caFile`：TLS 与鉴权参数
- `upstream.deviceTicket`：设备票据（可留空；client 会在收到服务端返回后自动更新内存态）
- `sessionHeartbeatIntervalMs`：会话心跳周期（毫秒，默认 `30000`，最小 `5000`）
- `localAuth.enabled` / `localAuth.username` / `localAuth.password`：本地 SOCKS5 认证
- `logLevel` / `metricsIntervalMs`：日志与指标输出
- `h2SessionPoolSize`：上游 H2 会话池大小
- `upstreamConnectTimeoutMs` / `streamResponseTimeoutMs` / `streamIdleTimeoutMs` / `localSocketIdleTimeoutMs`：超时参数
- `maxBufferedBytes` / `socksListenBacklog` / `localSocketKeepAliveInitialDelayMs`：连接与缓冲参数

会话行为说明：
- 运行中定期调用 `/session/ping` 维持在线与续租。
- 客户端停止时调用 `/session/offline` 显式释放；失败场景由 TTL 兜底回收。

## 日志与调试

可用环境变量覆盖日志等级：

```bash
LOG_LEVEL=DEBUG node bin/4px.js server -c config/server.json
LOG_LEVEL=ERROR node bin/4px.js client -c config/client.json
```

生产建议：

```bash
LOG_LEVEL=WARN node bin/4px.js server -c config/server.json
LOG_LEVEL=WARN node bin/4px.js client -c config/client.json
```

排障建议（网页首开慢 / 视频拖动恢复慢）：

- 先看服务端 `slow establish` 日志：
  - `connect_ms` 高：优先排查建连/DNS/出口网络。
  - `connect_ms` 低但 `ttfb_ms` 高：优先排查目标站/CDN 首包链路。
- 服务端日志已支持 `trace_id`，可与 Go 客户端日志对齐分析同一请求。
- `establishWarnMinIntervalMs` 用于慢日志限频，降低日志风暴对事件循环的影响。
- 若你需要排查慢链路，可临时设置 `slowEstablishEnabled=true` 打开慢日志收集，问题定位后再关闭。

鉴权失败排查：

- 服务端在 `401` 响应头中返回 `x-auth-reason`（如 `expired_user` / `disabled_user`）。
- Go GUI 会据此给出更明确提示（账号过期、账号禁用、token 无效），便于快速修复配置。
- 通用故障排查入口：`docs/ops-quick-reference.md`。

## Linux 一键部署（systemd）

```bash
cd apps/node
sudo bash ./deploy_systemd_server.sh
```

可选环境变量：
- `USE_CLUSTER`：`0/1`，`1` 时启用 cluster 模式
- `WORKERS`：worker 数量，默认 `2`
- `LIMIT_NOFILE`：`ulimit -n`，默认 `100000`
- `APPLY_SYSCTL`：`0/1`，`1` 时写入并应用内核参数

示例：

```bash
sudo USE_CLUSTER=1 WORKERS=4 APPLY_SYSCTL=1 bash ./deploy_systemd_server.sh
```

说明：
- systemd 部署默认不再注入 `LOG_LEVEL` 环境变量，日志等级以 `server.json` 的 `logLevel` 为准。

部署后服务名为 `4px`，常用命令：

```bash
sudo systemctl status 4px
sudo systemctl restart 4px
journalctl -u 4px -f
```

## 生产运维命令速查

以下命令默认在 Linux + systemd 环境使用，服务名为 `4px`。

1. 服务状态与启停

```bash
sudo systemctl status 4px
sudo systemctl start 4px
sudo systemctl stop 4px
sudo systemctl restart 4px
sudo systemctl daemon-reload
```

2. 日志查看（实时/历史）

```bash
journalctl -u 4px -f
journalctl -u 4px -n 200 --no-pager
journalctl -u 4px --since "10 min ago" --no-pager
```

3. 端口与进程检查

```bash
sudo ss -lntp | grep -E ":6666|:6688"
ps -ef | grep -E "node.*4px|4px.js" | grep -v grep
```

4. 配置校验与生效

```bash
cd /path/to/apps/node
node --check src/server.js
node --check src/admin_entry.js
python3 -m json.tool config/server.json >/dev/null
sudo systemctl restart 4px
```

5. 基础连通性自检（本机）

```bash
# 伪装页（应返回 200）
curl -k -I https://127.0.0.1:6666/

# 管理页（仅在 admin.enabled=true 且端口可达时）
curl -I http://127.0.0.1:6688/admin/login
```

6. 发布与回滚（最小流程）

```bash
# 发布
cd /path/to/repo
git pull
cd apps/node && npm ci --omit=dev
sudo systemctl restart 4px

# 回滚（示例：回退到上一版本 tag）
cd /path/to/repo
git checkout <previous-tag>
cd apps/node && npm ci --omit=dev
sudo systemctl restart 4px
```

7. 常见故障定位

```bash
# 鉴权失败
journalctl -u 4px --since "10 min ago" | grep -E "auth|401|x-auth-reason"

# 设备数限制拒绝
journalctl -u 4px --since "10 min ago" | grep -E "device limit exceeded|active_devices|max_devices"

# 过载拒绝/熔断
journalctl -u 4px --since "10 min ago" | grep -E "overload|circuit open"
```

## Redis（设备租约，集群防绕过）

当你启用 `USE_CLUSTER=1` 且要求严格设备数限制时，建议将 `deviceLeaseStore.mode` 设为 `redis`。

项目已提供 Redis compose 文件：

```bash
cd apps/node
docker compose -f docker-compose.redis.yml up -d
```

默认文件中使用了示例密码 `CHANGE_ME_REDIS_PASSWORD`，上线前请务必替换。

`server.json` 推荐配置：

```json
{
  "deviceLeaseStore": {
    "mode": "redis",
    "bindPeerIp": true,
    "prefix": "4px:device_lease",
    "redis": {
      "enabled": true,
      "url": "redis://127.0.0.1:6379",
      "password": "CHANGE_ME_REDIS_PASSWORD",
      "database": 0,
      "connectTimeoutMs": 5000
    }
  }
}
```

当前实现已废弃 `x-client-instance-id` 路径，仅使用 `x-device-ticket`。

## 当前能力与限制

- 支持 SOCKS5 `CONNECT`
- 支持 HTTP 代理（`CONNECT` + 普通 HTTP 请求）
- 支持 IPv4 / IPv6 / 域名目标
- 支持多用户鉴权（用户启停、有效期）
- 支持内置 Web 管理界面（用户增删改查）
- 暂不支持 SOCKS5 `UDP ASSOCIATE` / `BIND`
- `x-auth-token` 为基础鉴权，生产环境建议额外叠加 mTLS、限流与访问控制

## 多用户与 Web 管理

启用步骤：

```bash
cd apps/node
cp config/server.users.example.json config/server.users.json
# 修改 server.json 中 admin.token、users 文件路径等配置
node bin/4px.js server -c config/server.json
```

访问管理页：

```text
http://127.0.0.1:6688/admin
```

说明：
- `server.users.json` 属于敏感运行时数据，默认应仅保留本地，不提交到仓库。
- 首次访问会跳转到登录页：`/admin/login`，输入 `admin.token` 后进入管理页。
- 登录成功后使用 Cookie 维持登录态；也支持请求头 `Authorization: Bearer <admin.token>` 调用 API。
- 管理页已拆分为 Tab：用户管理、服务器资源、配置管理。
- 管理页资源页已分开展示：服务器整体资源 + 本进程资源占用（含占比）。
- 管理页支持在线查看/编辑 `server.json`（保存后需重启 server 生效）。
- 管理面默认独立进程运行（不再提供同进程模式）。
- 配置 `admin.serviceControl` 后，可在管理页一键重启 systemd 服务。
- `server.users.json` 中用户凭证字段为 `users[].authToken`。
- 用户管理支持导出备份与导入恢复（JSON 文件，导入默认合并，可选覆盖；导入前会显示预览）。
- 用户管理支持快捷续期：可按天/周/月指定续期时长并一键生效。
- 用户管理列表支持活跃设备数展示（用于设备上限策略排障）。
- 用户管理支持按用户导出 `client.json`（自动注入服务端地址、端口和该用户 `authToken`）。
- 新增/编辑用户后会写入 `server.users.json`，无需重启 server。
- 用户被禁用或到期后，新连接会被拒绝（已建立连接不强制断开）。

systemd 重启按钮权限建议（示例）：

```text
# /etc/sudoers.d/4px-admin
4px ALL=(root) NOPASSWD: /bin/systemctl restart 4px
```
