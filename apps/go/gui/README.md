# 4px Client (Wails)

这是 `4px` 的桌面客户端（`Go + Wails`），目标是跨平台桌面应用（macOS / Windows / Linux）。

当前默认主路径：`/proxy`。

## 当前能力

- 配置管理：读取/保存 `client.json`
- 客户端控制：启动/停止、运行状态、日志面板
- 会话状态：有效期查询（手动刷新）
- 系统代理：查看状态、开启、关闭
- 会话保活：运行期通过 `/session/ping` 保活，停止时调用 `/session/offline`
- 停止保护：支持“停止后自动关闭系统代理”（可选开关，默认开启）
- 退出保护：关闭 GUI 窗口时，若客户端由 GUI 启动且仍在运行，会自动执行“停止客户端 + 关闭系统代理”
- 模式固定：客户端仅使用 `upstream_path=/proxy`

## 目录

- `main.go`：Wails 启动入口
- `app.go`：客户端后端逻辑（直接调用 `apps/go/pkg/clientcore`）
- `frontend/index.html`：开发页面（`wails dev` 使用）
- `frontend/dist/index.html`：构建产物页面（嵌入打包）
- `wails.json`：Wails 项目配置

## 架构说明

- 客户端与 CLI 共享同一套 Go 核心能力：`apps/go/pkg/clientcore`
- 客户端不再通过 `go run ./cmd/4px` 间接调用 CLI
- `apps/go/cmd/4px` 现为薄入口，仅转调 `clientcore.RunCLI`

## 模式说明

- 默认模板使用 `upstream_path=/proxy`（稳定优先模式）。
- `clientcore` 会自动维护 `device_ticket`，无需手工干预。

## 本地运行（开发）

前置：

- Go 1.21+
- 安装 Wails CLI

```bash
go install github.com/wailsapp/wails/v2/cmd/wails@latest
```

运行：

```bash
cd apps/go/gui
$(go env GOPATH)/bin/wails dev
```

## 构建

```bash
cd apps/go/gui
$(go env GOPATH)/bin/wails build
```

使用一键发布脚本（推荐）：

```bash
cd apps/go/gui
./scripts/package_gui.sh --version v0.6.0
```

示例：在 macOS 构建 Windows（需要本机工具链满足条件）

```bash
$(go env GOPATH)/bin/wails build -platform windows/amd64
```

## 使用提示

- “停止 Client”仅控制由应用启动的实例。
- 若勾选“停止后自动关闭系统代理”，停止时会额外执行系统代理关闭。
- 点窗口左上角 `×` 退出时，应用会做一次同等清理（仅处理由本 GUI 启动的客户端实例）。

## 常见问题

依赖下载若出现 `proxy.golang.org` 超时，可临时切换代理后重试：

```bash
cd apps/go
GOPROXY=https://goproxy.cn,direct go mod tidy
```
