# 4px Node Agent

Node 版本的 `4px` 负责核心数据面，包含：
- `server`：远端入口，接收 `TLS + HTTP/2` 请求并转发到目标地址。
- `client`：本地入口，提供 `SOCKS5` 与 `HTTP` 代理，再转发到远端 `server`。
- `bin/4px.js`：统一 CLI 入口，支持自动初始化默认配置。

## 核心特性

- 统一数据面：当前版本固定 `proxy-only`（`POST /proxy`）。
- 低抖动优先：保留经典单流转发路径，时延行为更可预测。
- 可观测增强：支持 `trace_id` 贯通日志与慢建链诊断。
- 运维能力：支持 Web 管理端、systemd 部署、指标日志。
- 防护能力：内置背压处理与缓冲区上限控制，避免单连接拖垮进程。

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

- Node.js 18+（建议 LTS）
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
- `userRuntimeTrackingEnabled`：是否启用用户在线态运行时统计（默认 `false`；开启可在管理页查看在线/活跃状态）
- `userActivityUpdateIntervalMs`：用户“最近活跃”时间的采样更新间隔（毫秒，默认 `60000`）
- `admin.enabled` / `admin.listenHost` / `admin.listenPort` / `admin.token`：Web 管理端配置
- `admin.serviceControl.enabled` / `admin.serviceControl.systemdService` / `admin.serviceControl.useSudo`：Web 触发 systemd 重启配置
- `admin.clientConfigExport.*`：用户 client 配置导出默认值（`upstreamHost/upstreamPort/serverName/rejectUnauthorized/caFile`）
- `logLevel`：日志等级（`DEBUG/INFO/WARN/ERROR`）
- `listenBacklog`：监听 backlog
- `maxBufferedBytes`：单连接写缓冲上限
- `metricsIntervalMs`：指标日志输出周期
- `slowEstablishEnabled`：是否启用 `slow establish` 慢链路日志收集（默认 `false`；开启后输出慢日志与 summary）
- `slowEstablishTopN`：慢链路 summary 输出条数上限（默认 `5`）
- `establishWarnThresholdMs`：建链慢日志阈值（毫秒，默认 `1500`，超过会打印 `slow establish` 警告）
- `establishWarnMinIntervalMs`：同目标慢建链日志最小间隔（毫秒，默认 `5000`，用于限频降噪）
- `remoteErrorLogMinIntervalMs`：`remote connection error` 同目标日志最小输出间隔（毫秒，默认 `3000`；`0` 表示不限制）
- `h2HeaderTableSize` / `h2InitialWindowSize` / `h2MaxConcurrentStreams` / `h2MaxFrameSize` / `h2MaxHeaderListSize` / `h2EnableConnectProtocol`：HTTP/2 连接参数（默认值见配置文件，通常保持默认）
- `remoteConnectTimeoutMs`：到目标地址连接超时
- `remoteAutoSelectFamily`：是否启用 Node 的双栈自动建连（Happy Eyeballs 等价能力，默认 `true`）
- `remoteAutoSelectFamilyAttemptTimeoutMs`：双栈竞速延迟（毫秒，默认 `300`）
- `remoteConnectMaxInFlight`：server 同时进行中的出站建连上限（默认 `4096`；超过会快速返回 `503`，用于抑制建连风暴）
- `remoteIdleTimeoutMs`：目标连接空闲超时（`0` 表示关闭）
- `remoteKeepAliveInitialDelayMs`：目标连接 KeepAlive 初始延迟
- `streamIdleTimeoutMs`：H2 stream 空闲超时（`0` 表示关闭）

### 正向代理性能优化项（server）

- 双栈自动建连：开启 `remoteAutoSelectFamily=true` 后，server 出站建连会自动在 IPv4/IPv6 间做快速择优，降低 DNS/网络波动时的 `connect_ms` 尾延迟。
- 竞速延迟控制：`remoteAutoSelectFamilyAttemptTimeoutMs` 控制双栈竞速间隔，默认 `300ms`。网络较稳可适当调低（如 `150~250`），网络复杂建议保持默认。
- 建连风暴保护：`remoteConnectMaxInFlight` 用于限制同时进行中的目标建连数；超阈值请求会快速返回 `503`，避免 event loop 被大量慢建连拖垮。
- 兼容回退：若当前 Node 运行时不支持 `autoSelectFamily`，server 会自动回退到默认 `net.createConnection` 行为，不影响服务可用性。
- 启动可观测：server 启动日志会打印 `remote auto select family enabled=... attempt_timeout_ms=...`，用于确认配置是否生效。
- 建议搭配：生产环境建议和 `slowEstablishEnabled`、`establishWarnThresholdMs` 一起使用，持续观察 `connect_ms` 与 `ttfb_ms` 的变化。

### 推荐生产参数模板（server）

低延迟优先（先压 `connect_ms` 尾延迟）：

```json
{
  "remoteAutoSelectFamily": true,
  "remoteAutoSelectFamilyAttemptTimeoutMs": 200,
  "remoteConnectMaxInFlight": 3072,
  "remoteConnectTimeoutMs": 12000,
  "remoteIdleTimeoutMs": 240000,
  "streamIdleTimeoutMs": 240000,
  "slowEstablishEnabled": true,
  "establishWarnThresholdMs": 1200,
  "establishWarnMinIntervalMs": 5000,
  "remoteErrorLogMinIntervalMs": 3000
}
```

稳定优先（先控波动与日志开销）：

```json
{
  "remoteAutoSelectFamily": true,
  "remoteAutoSelectFamilyAttemptTimeoutMs": 300,
  "remoteConnectMaxInFlight": 4096,
  "remoteConnectTimeoutMs": 15000,
  "remoteIdleTimeoutMs": 300000,
  "streamIdleTimeoutMs": 300000,
  "slowEstablishEnabled": false,
  "establishWarnThresholdMs": 1500,
  "establishWarnMinIntervalMs": 5000,
  "remoteErrorLogMinIntervalMs": 3000
}
```

使用建议：

- 先用“稳定优先”跑 1~2 天观察基线，再切“低延迟优先”做 AB 对比。
- `remoteAutoSelectFamilyAttemptTimeoutMs` 建议调节范围 `150~400`，每次调整不超过 `50ms`。
- `remoteConnectMaxInFlight` 建议从 `2048/3072/4096` 分档试验，观察 `remote_connect_overload_reject` 与 p95/p99 的平衡点。
- 若出现日志量激增，先提高 `establishWarnThresholdMs`，再考虑关闭 `slowEstablishEnabled`。

### `client.json`

- `socksListenHost` / `socksListenPort`：本地 SOCKS5 监听
- `httpListen`：本地 HTTP 代理监听地址（例如 `127.0.0.1:7788`）
- `httpListenBacklog`：HTTP 代理监听 backlog
- `upstream.host` / `upstream.port`：远端 server 地址
- `upstream.path`：上游路径（固定 `/proxy`）
- `upstream.servername`：TLS SNI / 证书名称
- `upstream.authToken`：上游鉴权 token（填某个用户 `authToken` 或命中 `authTokens` 列表的 token）
- `upstream.caFile`：自定义 CA 文件路径（可选）
- `upstream.rejectUnauthorized`：是否严格校验证书
- `h2SessionPoolSize`：H2 会话池大小（默认 `1`，单用户低抖动优先）
- `localAuth`：本地 SOCKS5 用户名密码认证
- `logLevel`：日志等级
- `maxBufferedBytes`：单连接写缓冲上限
- `metricsIntervalMs`：指标日志输出周期
- `socksListenBacklog`：SOCKS5 监听 backlog
- `upstreamConnectTimeoutMs`：到上游连接超时
- `streamResponseTimeoutMs`：stream 等待响应头超时
- `streamIdleTimeoutMs`：stream 空闲超时（`0` 表示关闭）
- `localSocketIdleTimeoutMs`：本地连接空闲超时（`0` 表示关闭）

## 模式选择

- 当前版本为 `proxy` 单一路径：
  - 客户端配置：`upstream.path = "/proxy"`
  - 服务端路由：`POST /proxy`
  - 特点：经典单流模型，时延行为更可预测，维护成本更低。

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

## Linux 一键部署（systemd）

```bash
cd apps/node
sudo bash ./deploy_systemd_server.sh
```

可选环境变量：
- `LOG_LEVEL`：默认 `WARN`
- `USE_CLUSTER`：`0/1`，`1` 时启用 cluster 模式
- `WORKERS`：worker 数量，默认 `2`
- `LIMIT_NOFILE`：`ulimit -n`，默认 `100000`
- `APPLY_SYSCTL`：`0/1`，`1` 时写入并应用内核参数

示例：

```bash
sudo USE_CLUSTER=1 WORKERS=4 LOG_LEVEL=WARN APPLY_SYSCTL=1 bash ./deploy_systemd_server.sh
```

部署后服务名为 `4px`，常用命令：

```bash
sudo systemctl status 4px
sudo systemctl restart 4px
journalctl -u 4px -f
```

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
- 首次访问会跳转到登录页：`/admin/login`，输入 `admin.token` 后进入管理页。
- 登录成功后使用 Cookie 维持登录态；也支持请求头 `Authorization: Bearer <admin.token>` 调用 API。
- 管理页已拆分为 Tab：用户管理、服务器资源、配置管理。
- 管理页资源页已分开展示：服务器整体资源 + 本进程资源占用（含占比）。
- 管理页支持在线查看/编辑 `server.json`（保存后需重启 server 生效）。
- 配置 `admin.serviceControl` 后，可在管理页一键重启 systemd 服务。
- `server.users.json` 中用户凭证字段为 `users[].authToken`。
- 用户管理支持导出备份与导入恢复（JSON 文件，导入默认合并，可选覆盖；导入前会显示预览）。
- 用户管理支持快捷续期：可按天/周/月指定续期时长并一键生效。
- 用户管理列表支持在线状态、当前连接数、最近活跃时间展示。
- 用户管理支持按用户导出 `client.json`（自动注入服务端地址、端口和该用户 `authToken`）。
- 新增/编辑用户后会写入 `server.users.json`，无需重启 server。
- 用户被禁用或到期后，新连接会被拒绝（已建立连接不强制断开）。

systemd 重启按钮权限建议（示例）：

```text
# /etc/sudoers.d/4px-admin
4px ALL=(root) NOPASSWD: /bin/systemctl restart 4px
```
