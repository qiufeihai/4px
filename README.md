# 4px

`4px` 是一个跨语言代理工具集，当前包含：
- Node.js 数据面（`apps/node`）：提供 `server` 与 `client` 两个进程，协议为 `TLS + HTTP/2`。
- Go 客户端（`apps/go`）：兼容 Node `server` 协议，额外提供系统代理开关能力。

适用场景：
- 你有一台远端服务器，想通过单条 TLS 连接承载多路代理流量。
- 你希望在本地用 `SOCKS5/HTTP` 代理方式接入，再由上游统一转发。
- 你希望跨平台（Linux/macOS/Windows）运行客户端。

## 仓库结构

```text
4px/
  apps/
    node/                 # Node.js agent（server + client + CLI + systemd 脚本）
      bin/4px.js          # Node 统一命令入口
      src/server.js
      src/client.js
      config/*.json
    go/                   # Go 客户端
      cmd/4px/main.go
      config/client.example.json
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

## 运行建议

- 开发调试：优先使用前台运行（直接命令启动），便于看日志。
- 生产部署：Node `server` 推荐使用 `apps/node/deploy_systemd_server.sh`。
- 日志等级：默认建议 `WARN`，排障时临时切换 `DEBUG`。

## 文档导航

- Node 详细说明：`apps/node/README.md`
- Go 详细说明：`apps/go/README.md`
