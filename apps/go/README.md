# 4px Go Client

Go 版本客户端用于连接 Node `server`，并提供跨平台系统代理开关。

协议兼容：
- 上游协议：`TLS + HTTP/2`
- 请求路径：`POST /proxy`
- 关键请求头：`x-auth-token`、`x-target-host`、`x-target-port`

## 核心特性

- 稳定优先默认：默认 `upstream_path=/proxy`，链路更直接、低抖动。
- 架构复用：CLI 与 GUI 共享 `pkg/clientcore`，避免双实现漂移。
- 跨平台代理：统一封装系统代理启停与状态查询（macOS/Windows/Linux）。

## 架构说明

- `cmd/4px/main.go`：CLI 入口（薄封装）
- `pkg/clientcore`：核心能力（配置加载、代理运行、系统代理控制/状态）
- GUI（`apps/go/gui`）与 CLI（`apps/go/cmd/4px`）共用同一 `clientcore`

## 目录

- `cmd/4px/main.go`：主程序入口
- `gui/`：Wails GUI（桌面端）
- `pkg/clientcore`：Go 客户端核心能力
- `config/client.example.json`：配置模板

## 前置要求

- Go 1.21+（建议）
- 一个可用的 Node `server`（见 `apps/node/README.md`）

## 快速开始

### 1. 准备配置

```bash
cd apps/go
cp config/client.example.json config/client.json
```

至少确认这些字段：
- `upstream_host`
- `upstream_port`
- `server_name`
- `auth_token`

### 2. 启动客户端

```bash
go run ./cmd/4px -c config/client.json run
```

默认监听：
- SOCKS5：`127.0.0.1:7777`
- HTTP：`127.0.0.1:7788`

## 命令用法

```bash
4px [-c config/client.json] [run|sysproxy-enable|sysproxy-disable|sysproxy-status]
```

等价示例：

```bash
go run ./cmd/4px -c config/client.json run
go run ./cmd/4px -c config/client.json sysproxy-enable
go run ./cmd/4px -c config/client.json sysproxy-disable
go run ./cmd/4px -c config/client.json sysproxy-status
```

说明：
- 未传 `-c` 时默认读取当前目录 `./client.json`。
- 若 `./client.json` 不存在，会自动创建模板并提示“先修改配置再重启”。
- `sysproxy-enable` 会同时设置系统 `HTTP/HTTPS/SOCKS` 代理。

## 配置项说明

`config/client.json` 主要字段：
- `socks_listen`：本地 SOCKS5 监听地址
- `http_listen`：本地 HTTP 代理监听地址
- `upstream_host` / `upstream_port`：远端 server 地址
- `upstream_path`：固定 `/proxy`（稳定优先）
- `server_name`：TLS `ServerName`（SNI/证书校验）
- `auth_token`：鉴权 token
- `reject_unauthorized`：是否严格校验证书
- `ca_file`：自定义 CA 文件（可选）
- `upstream_connect_timeout_ms`：连接上游超时
- `response_header_timeout_ms`：响应头超时
- `idle_timeout_ms`：空闲超时
- `log_level`：日志等级（`DEBUG/INFO/WARN/ERROR`）

## 模式说明

- 当前版本为 `proxy` 单路径：
  - 每个目标连接对应独立上游 stream，链路直观，时延行为更可预测。

## 系统代理行为

- macOS：使用 `networksetup` 对所有网络服务设置/清理 `web/secureweb/socks` 代理
- Windows：通过注册表 `Internet Settings` 设置 `ProxyServer` 与 `ProxyEnable`
- Linux：通过 `gsettings` 设置 GNOME 代理模式（`manual/none`）

查看状态：

```bash
go run ./cmd/4px -c config/client.json sysproxy-status
```

排障建议（开启 DEBUG）：

```bash
LOG_LEVEL=DEBUG go run ./cmd/4px -c config/client.json sysproxy-enable
LOG_LEVEL=DEBUG go run ./cmd/4px -c config/client.json sysproxy-status
```

## 构建

### 本机构建

```bash
go build -o bin/4px ./cmd/4px
```

### 跨平台构建

Linux:

```bash
GOOS=linux GOARCH=amd64 go build -o bin/4px-linux-amd64 ./cmd/4px
```

macOS:

```bash
GOOS=darwin GOARCH=amd64 go build -o bin/4px-darwin-amd64 ./cmd/4px
GOOS=darwin GOARCH=arm64 go build -o bin/4px-darwin-arm64 ./cmd/4px
```

Windows:

```bash
GOOS=windows GOARCH=amd64 go build -o bin/4px-windows-amd64.exe ./cmd/4px
```

## 注意事项

- 当 `reject_unauthorized=true` 时，`server_name` 必须与证书匹配。
- 客户端内部已禁用“跟随系统代理”以避免请求回环。
- Linux 非 GNOME 环境下，`sysproxy-enable/disable/status` 可能需要改为手动设置系统代理。
