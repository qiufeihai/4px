# 4px Node Agent

Node 版本的 `4px` 负责核心数据面，包含：
- `server`：远端入口，接收 `TLS + HTTP/2` 请求并转发到目标地址。
- `client`：本地入口，提供 `SOCKS5` 与 `HTTP` 代理，再转发到远端 `server`。
- `bin/4px.js`：统一 CLI 入口，支持自动初始化默认配置。

## 目录说明

- `bin/4px.js`：命令入口（`server` / `client` / `help`）
- `src/server.js`：上游服务端
- `src/client.js`：本地客户端
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
- `authToken`：鉴权 token（需与 client 一致）
- `logLevel`：日志等级（`DEBUG/INFO/WARN/ERROR`）
- `listenBacklog`：监听 backlog
- `maxBufferedBytes`：单连接写缓冲上限
- `metricsIntervalMs`：指标日志输出周期
- `remoteConnectTimeoutMs`：到目标地址连接超时
- `remoteIdleTimeoutMs`：目标连接空闲超时（`0` 表示关闭）
- `streamIdleTimeoutMs`：H2 stream 空闲超时（`0` 表示关闭）

### `client.json`

- `socksListenHost` / `socksListenPort`：本地 SOCKS5 监听
- `httpListen`：本地 HTTP 代理监听地址（例如 `127.0.0.1:7788`）
- `httpListenBacklog`：HTTP 代理监听 backlog
- `upstream.host` / `upstream.port`：远端 server 地址
- `upstream.servername`：TLS SNI / 证书名称
- `upstream.authToken`：鉴权 token
- `upstream.caFile`：自定义 CA 文件路径（可选）
- `upstream.rejectUnauthorized`：是否严格校验证书
- `h2SessionPoolSize`：H2 会话池大小
- `localAuth`：本地 SOCKS5 用户名密码认证
- `logLevel`：日志等级
- `maxBufferedBytes`：单连接写缓冲上限
- `metricsIntervalMs`：指标日志输出周期
- `socksListenBacklog`：SOCKS5 监听 backlog
- `upstreamConnectTimeoutMs`：到上游连接超时
- `streamResponseTimeoutMs`：stream 等待响应头超时
- `streamIdleTimeoutMs`：stream 空闲超时（`0` 表示关闭）
- `localSocketIdleTimeoutMs`：本地连接空闲超时（`0` 表示关闭）

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
- 暂不支持 SOCKS5 `UDP ASSOCIATE` / `BIND`
- `x-auth-token` 为基础鉴权，生产环境建议额外叠加 mTLS、限流与访问控制
