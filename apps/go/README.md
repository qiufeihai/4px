# 4px Go Client

Go 版本客户端用于连接 Node `server`，并提供跨平台系统代理开关。

协议兼容：
- 上游协议：`TLS + HTTP/2`
- 请求路径：`POST /proxy`
- 关键请求头：`x-auth-token`、`x-target(base64url(host:port))`

## 目录

- `cmd/4px/main.go`：主程序入口
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
- 未传 `-c` 时默认读取 `config/client.json`。
- `sysproxy-enable` 会同时设置系统 `HTTP/HTTPS/SOCKS` 代理。

## 配置项说明

`config/client.json` 主要字段：
- `socks_listen`：本地 SOCKS5 监听地址
- `http_listen`：本地 HTTP 代理监听地址
- `upstream_host` / `upstream_port`：远端 server 地址
- `server_name`：TLS `ServerName`（SNI/证书校验）
- `auth_token`：鉴权 token
- `reject_unauthorized`：是否严格校验证书
- `ca_file`：自定义 CA 文件（可选）
- `upstream_connect_timeout_ms`：连接上游超时
- `response_header_timeout_ms`：响应头超时
- `idle_timeout_ms`：空闲超时
- `log_level`：日志等级（`DEBUG/INFO/WARN/ERROR`）

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
