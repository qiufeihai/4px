# GUI 发布包命名与版本规范

本文档约定 `apps/go/gui` 的桌面客户端发布规范，目标是让你在单人维护场景下也能快速追溯“这个安装包对应哪次代码与配置”。

## 命名规范

GUI 发布包文件名统一为：

```text
4px-gui_<version>_<platform>_<arch>_<gitsha>.zip
```

示例：

```text
4px-gui_v0.6.0_darwin_arm64_a1b2c3d.zip
4px-gui_20260505-121500_darwin_arm64_a1b2c3d.zip
```

字段说明：
- `version`：优先使用你手动输入的版本号（如 `v0.6.0`）；未提供时用时间戳。
- `platform`：`darwin` / `windows` / `linux`。
- `arch`：`arm64` / `amd64`。
- `gitsha`：当前 commit 短哈希（7 位），便于回溯源码。

## 版本策略（单人维护建议）

- 功能新增：小版本递增（如 `v0.6.0 -> v0.7.0`）。
- 修复优化：补丁版本递增（如 `v0.6.0 -> v0.6.1`）。
- 本地试包：可直接用时间戳版本（无需严格语义化）。

## 一键打包脚本

已提供脚本：

```text
apps/go/gui/scripts/package_gui.sh
```

常用命令：

```bash
cd apps/go/gui
./scripts/package_gui.sh --version v0.6.0
```

脚本会执行：
- 自动调用 `wails build -clean`；
- 从 `build/bin/*.app` 取最新 GUI 产物；
- 产出 zip 到 `apps/go/gui/releases/`；
- 同目录生成一个 `*.meta.txt` 元数据文件。

## 发布前最小检查

- GUI 能正常启动；
- 可加载并保存配置；
- 可启动/停止 client；
- `upstream_path=/proxy-v2` 时代理请求可达；
- 发布包名包含正确的 `version` 与 `gitsha`。

## 回滚约定

- 保留上一个稳定发布包（至少 1 个）。
- 新版本异常时直接回滚到上个 zip 包；
- 运行中链路异常可改配置回退到 `/proxy`。
