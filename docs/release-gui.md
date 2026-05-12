# GUI 发布包命名与版本规范

本文档约定 `apps/go/gui` 的桌面客户端发布规范，目标是让你在单人维护场景下也能快速追溯“这个安装包对应哪次代码与配置”。

## 命名规范

GUI 发布目录命名统一为：

```text
4px-client_<version>_<platform>_<arch>_<gitsha>
```

示例：

```text
4px-client_v0.6.0_darwin_arm64_a1b2c3d
4px-client_20260505-121500_darwin_arm64_a1b2c3d
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
- 自动调用 `wails build`；
- 从 `build/bin/*.app` 取最新 GUI 产物；
- 在 `apps/go/gui/releases/` 产出一个发布目录（内含 `.app`）；
- 同目录生成一个 `*.meta.txt` 元数据文件。

## 发布前最小检查

- GUI 能正常启动；
- 可加载并保存配置；
- 可启动/停止 client；
- `upstream_path=/proxy` 时代理请求可达；
- 发布包名包含正确的 `version` 与 `gitsha`。

推荐加一条固定健康检查（本地代理）：

```bash
seq 200 | xargs -P 40 -I{} sh -c 'curl -sS -o /dev/null -x http://127.0.0.1:7788 https://206.119.179.201:8080/ --max-time 30; echo $?' | awk 'BEGIN{ok=0;fail=0}{if($1==0) ok++; else fail++} END {print "ok="ok,"fail="fail,"rate="(ok*100/(ok+fail))"%"}'
```

判定建议：
- `rate >= 99%`：通过；
- `rate < 99%`：先重启 GUI client 后复测，再看日志定位。

## 回滚约定

- 保留上一个稳定发布包（至少 1 个）。
- 新版本异常时直接回滚到上个发布目录（或其归档）；
- 运行中链路异常时优先检查服务端连通性、鉴权与系统代理状态，再执行回滚。

## 发布到 GitHub（手动）

推荐手动发布（单人维护更可控），步骤如下：

1. 提交并推送代码

```bash
cd /path/to/4px
git status
git add -A
git commit -m "release: gui v0.6.0"
git push origin main
```

2. 本地打包发布文件

```bash
cd apps/go/gui
./scripts/package_gui.sh --version v0.6.0
```

打包后文件在：
- `apps/go/gui/releases/4px-client_<version>_darwin_<arch>_<gitsha>/`
- `apps/go/gui/releases/*.meta.txt`

可选方案（当你本地没有 Windows 构建环境）：

- 使用 GitHub Actions：`.github/workflows/gui-build.yml`
- 在 `Actions -> GUI Build Artifacts -> Run workflow` 输入版本号后触发
- 工作流会在 `macos-latest` 和 `windows-latest` 分别构建并上传 artifact
- 下载 artifact 后解压一次，直接上传到同一个 GitHub Release

常见问题：

- 看不到 `Run workflow` 按钮：
  - 确认你在仓库有写权限；
  - 确认该 workflow 文件已经在默认分支；
  - 确认仓库 `Actions` 未被禁用。
- 只有一个平台成功：
  - 先发布成功的平台包；
  - 失败平台可重新 `Re-run failed jobs` 后补传。

3. 在 GitHub 创建 Release

- 打开仓库页面 -> `Releases` -> `Draft a new release`
- `Choose a tag` 输入：`v0.6.0`（不存在时可直接创建）
- `Target` 选择 `main`
- `Release title` 填：`v0.6.0`
- 描述区填本次变更摘要（可参考下方模板）
- 上传发布文件：
  - 本地脚本产物目录：`4px-client_v0.6.0_darwin_<arch>_<gitsha>/`
  - workflow 产物（mac）：`4px-client_v0.6.0_darwin_<arch>_<gitsha>`（artifact 名称）
  - workflow 产物（win）：`4px-client_v0.6.0_windows_amd64_<gitsha>`（artifact 名称）
  - `4px-client_v0.6.0_darwin_<arch>_<gitsha>.meta.txt`（本地脚本产物）
- 点击 `Publish release`

4. 发布后自检

- 在 Releases 页面下载刚发布的产物；
- 确认应用可启动；
- 按“发布前最小检查”再做一次健康验证。

## Release Note 模板

```text
## 4px GUI v0.6.0

### Highlights
- Default mode keeps `/proxy`.
- Timeout defaults updated for stability.
- Added one-click GUI packaging script.

### Verification
- GUI start/stop/config read-write passed.
- Proxy health check passed (rate >= 99%).

### Artifacts
- 4px-client_v0.6.0_darwin_<arch>_<gitsha>
- 4px-client_v0.6.0_darwin_<arch>_<gitsha> (workflow artifact)
- 4px-client_v0.6.0_windows_amd64_<gitsha> (workflow artifact)
- 4px-client_v0.6.0_darwin_<arch>_<gitsha>.meta.txt
```
