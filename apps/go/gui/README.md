# 4px GUI Client (Wails)

这是 `4px` 的 GUI 客户端（`Go + Wails`），目标是跨平台桌面应用（macOS / Windows / Linux）。

## 当前能力

- 配置管理：读取/保存 `client.json`
- 客户端控制：启动/停止、运行状态、日志面板
- 系统代理：查看状态、开启、关闭
- 停止保护：支持“停止后自动关闭系统代理”（可选开关，默认开启）
- 模式可控：可在 GUI 配置中选择 `upstream_path` 为 `/proxy-v2` 或 `/proxy`

## 目录

- `main.go`：Wails 启动入口
- `app.go`：GUI 后端逻辑（直接调用 `apps/go/pkg/clientcore`）
- `frontend/index.html`：开发页面（`wails dev` 使用）
- `frontend/dist/index.html`：构建产物页面（嵌入打包）
- `wails.json`：Wails 项目配置

## 架构说明

- GUI 与 CLI 共享同一套 Go 核心能力：`apps/go/pkg/clientcore`
- GUI 不再通过 `go run ./cmd/4px` 间接调用 CLI
- `apps/go/cmd/4px` 现为薄入口，仅转调 `clientcore.RunCLI`

## 模式说明

- 默认模板使用 `upstream_path=/proxy-v2`（最高性能模式）。
- 若需要兼容回退，可把 `upstream_path` 改为 `/proxy`。
- 模式严格按配置生效，不做隐式自动回退。

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

- “停止 Client”仅控制由 GUI 启动的实例。
- 若勾选“停止后自动关闭系统代理”，停止时会额外执行系统代理关闭。
- 配置路径默认无需手填：
  - 开发环境优先使用 `apps/go/client.json`。
  - 编译后的 `.app` 优先使用当前运行目录的 `client.json`。
  - 若默认位置不存在 `client.json`，会自动创建一份模板配置。

健康检查（升级后建议执行一次）：

```bash
seq 200 | xargs -P 40 -I{} sh -c 'curl -sS -o /dev/null -x http://127.0.0.1:7788 https://206.119.179.201:8080/ --max-time 30; echo $?' | awk 'BEGIN{ok=0;fail=0}{if($1==0) ok++; else fail++} END {print "ok="ok,"fail="fail,"rate="(ok*100/(ok+fail))"%"}'
```

判定建议：
- `rate >= 99%`：通过；
- `rate < 99%`：先重启 GUI client 后复测，再看日志定位。

## 常见问题

依赖下载若出现 `proxy.golang.org` 超时，可临时切换代理后重试：

```bash
cd apps/go
GOPROXY=https://goproxy.cn,direct go mod tidy
```
