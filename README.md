# 4px

`4px` 是一套以 Node 服务端 + Go 客户端为核心的代理工具集。

- 服务端：`apps/node`（`server` + `admin`）
- 客户端核心：`apps/go/pkg/clientcore`
- 桌面端：`apps/go/gui`（Wails，复用 `clientcore`）
- 移动端：`apps/mobile/android`、`apps/mobile/ios`（通过 `gomobile` 复用 Go 核心）

## 当前默认能力

- 数据面主路径固定为 `/proxy`（proxy-only）。
- 会话控制面为 `/session/status`、`/session/ping`、`/session/offline`。
- 客户端默认同时提供本地 `SOCKS5` 与 `HTTP` 代理入口。

## 架构概览

```text
Browser/App
  -> Local SOCKS5/HTTP Proxy (Go/Node client)
  -> TLS + HTTP/2
  -> Node Server (/proxy)
  -> Target Host:Port
```

```text
Client runtime
  -> /session/ping    (维持在线与 device_ticket 刷新)
  -> /session/status  (到期状态查询)
  -> /session/offline (显式离线释放)
```

## 快速开始

### Node server + Go client（推荐）

```bash
cd apps/node
npm install
node bin/4px.js server -c config/server.json

cd ../go
cp config/client.example.json config/client.json
go run ./cmd/4px -c config/client.json run
```

### 仅使用 Node（兼容保留）

```bash
cd apps/node
npm install
node bin/4px.js server -c config/server.json
node bin/4px.js client -c config/client.json
```

## 仓库结构

```text
apps/
  node/        # server + admin + node client
  go/          # clientcore + CLI + GUI
  mobile/      # Android/iOS 客户端
docs/          # 运维/发布/性能文档
.github/workflows/
```

## 文档导航

- Node：`apps/node/README.md`
- Go CLI/Core：`apps/go/README.md`
- GUI：`apps/go/gui/README.md`
- 移动端：`apps/mobile/README.md`
- 运维速查：`docs/ops-quick-reference.md`
- GUI 发布：`docs/release-gui.md`
- 性能记录：`docs/performance-todo.md`
- 版本号与变更日志：`docs/versioning.md`
- AI 开发规则：`docs/ai-rules.md`
