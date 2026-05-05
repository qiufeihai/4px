# 4px

`4px` 是一个跨语言代理工具集，当前包含：
- Node.js 数据面（`apps/node`）：提供 `server` 与 `client` 两个进程，协议为 `TLS + HTTP/2`。
- Go 客户端（`apps/go`）：兼容 Node `server` 协议，额外提供系统代理开关能力。
- GUI 客户端（`apps/go/gui`）：基于 `Go + Wails` 的跨平台桌面版（开发中）。

适用场景：
- 你有一台远端服务器，想通过单条 TLS 连接承载多路代理流量。
- 你希望在本地用 `SOCKS5/HTTP` 代理方式接入，再由上游统一转发。
- 你希望跨平台（Linux/macOS/Windows）运行客户端。

## 项目特性

- 双客户端实现：Node 与 Go 客户端都可对接同一 Node server。
- 双代理入口：本地同时提供 `SOCKS5` 与 `HTTP` 代理监听。
- 双模式转发：支持 `proxy`（经典单流）与 `proxy-v2`（mux 多路复用）。
- 强一致配置：模式选择严格按配置生效，不做隐式协议降级。
- 可观测性：内置运行指标、日志等级、连接状态与 GUI 状态展示。
- 可运维性：Node server 支持 systemd 部署、管理端与配置在线维护。

## 总体架构

```text
Browser/App
  -> Local SOCKS5/HTTP Proxy (Node client or Go client)
  -> TLS + HTTP/2 Tunnel
  -> Node Server
  -> Target Host:Port
```

- 数据面：`apps/node/src/server.js` 负责上游接入、鉴权、转发与指标。
- 客户端面：`apps/node/src/client.js` 与 `apps/go/pkg/clientcore` 负责本地代理与上游隧道。
- 控制面：`apps/node/src/admin`（Web 管理）与 `apps/go/gui`（桌面 GUI）提供运维入口。

## 模式说明（`/proxy` vs `/proxy-v2`）

- `proxy`：
  - 每个目标连接对应上游独立 stream。
  - 协议简单、兼容性强，便于排障与回滚。
- `proxy-v2`：
  - 基于 mux 在单主通道内承载多路子流。
  - 减少建链与头部开销，吞吐与并发效率更高。

默认策略：
- 项目默认配置使用 `proxy-v2`（最高性能模式）。
- 若需回退，显式把客户端配置改为 `proxy` 即可。
- 模式选择严格按配置执行，不做“v2 失败自动回退 v1”。

## 优势总结

- 性能：`proxy-v2` 通过多路复用降低连接与协议开销。
- 稳定：保留 `proxy` 作为可控回退路径，便于灰度与故障隔离。
- 可维护：Go/CLI/GUI 复用 `clientcore`，Node 侧 server/client 职责清晰。
- 易部署：Node server 可直接接入 systemd，客户端支持多平台运行。

## 仓库结构

```text
4px/
  apps/
    node/                 # Node.js agent（server + client + CLI + systemd 脚本）
      bin/4px.js          # Node 统一命令入口
      src/server.js
      src/client.js
      config/*.json
    go/                   # Go 客户端（CLI + 可复用 core）
      cmd/4px/main.go
      pkg/clientcore/
      config/client.example.json
      gui/                # GUI 客户端（Wails）
        main.go
        app.go
        frontend/dist/index.html
  .github/workflows/ci.yml
```

## 快速开始

### 路线 A：只使用 Node

```bash
cd apps/node
npm install
node bin/4px.js server -c config/server.json
node bin/4px.js client -c config/client.json
```

### 路线 B：Node server + Go client

```bash
# 1) 启动 Node server
cd apps/node
npm install
node bin/4px.js server -c config/server.json

# 2) 启动 Go client（新终端）
cd apps/go
cp config/client.example.json config/client.json
go run ./cmd/4px -c config/client.json run
```

## 配置入口索引

- Node server 示例：`apps/node/config/server.example.json`
- Node 多用户示例：`apps/node/config/server.users.example.json`
- Node client 示例：`apps/node/config/client.example.json`
- Node 本地调试默认：`apps/node/config/server.json`、`apps/node/config/client.json`
- Go client 示例：`apps/go/config/client.example.json`
- GUI 说明：`apps/go/gui/README.md`

## 常用命令

### Node 侧

```bash
cd apps/node
node bin/4px.js help
node bin/4px.js server -c config/server.json
node bin/4px.js client -c config/client.json
```

说明：
- 未传 `-c` 时，CLI 默认在当前目录找 `server.json` 或 `client.json`。
- 若文件不存在，CLI 会自动在当前目录初始化模板并提示“先修改配置再运行”。

### Go 侧

```bash
cd apps/go
go run ./cmd/4px -c config/client.json run
go run ./cmd/4px -c config/client.json sysproxy-enable
go run ./cmd/4px -c config/client.json sysproxy-disable
go run ./cmd/4px -c config/client.json sysproxy-status
```

说明：
- `apps/go/cmd/4px` 是 CLI 入口，核心逻辑在 `apps/go/pkg/clientcore`。
- `apps/go/gui` 直接复用 `clientcore`，不再通过 `go run ./cmd/4px` 间接调用。

## 运行建议

- 开发调试：优先使用前台运行（直接命令启动），便于看日志。
- 生产部署：Node `server` 推荐使用 `apps/node/deploy_systemd_server.sh`。
- 日志等级：默认建议 `WARN`，排障时临时切换 `DEBUG`。

## 文档导航

- Node 详细说明：`apps/node/README.md`
- Go 详细说明：`apps/go/README.md`
- GUI 详细说明：`apps/go/gui/README.md`
- GUI 发布规范：`docs/release-gui.md`
