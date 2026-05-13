## 版本号与变更日志（server/client 双版本）

本仓库按 **server/client 双版本** 管理，目标是：
- 让版本号可被 AI 按规则自动分配
- 让 CHANGELOG 可被 AI 按规则自动维护
- 降低多端（GUI/Android/iOS）同步成本

### 版本文件（单一来源）

- `VERSION.server`：Node 服务端（含 admin）的对外版本号（SemVer：`X.Y.Z`）
- `VERSION.client`：客户端族（Go CLI/GUI + Android + iOS）的对外版本号（SemVer：`X.Y.Z`）

发布时，**workflow/产物命名使用对应版本号**，并附带 git short sha 便于追溯。

### 变更日志（Keep a Changelog）

- `CHANGELOG.server.md`
- `CHANGELOG.client.md`

格式约定：
- 永远保留 `## Unreleased` 段落，用于累计未发布变更
- 发布时把 `Unreleased` 内容“切出”为 `## vX.Y.Z - YYYY-MM-DD`
- 采用小节：`Added / Changed / Fixed / Removed / Security`

### 何时改哪个版本

#### 改 server 版本（只改 `VERSION.server` + `CHANGELOG.server.md`）

包含但不限于：
- `apps/node/src/server.js`、`apps/node/src/admin/**`、`apps/node/src/*`（服务端/管理面/协议与鉴权）
- 服务端配置格式（`apps/node/config/server*.json`）与兼容性变更
- 服务端性能与稳定性策略（过载、熔断、lease/ticket 行为、路由等）

#### 改 client 版本（只改 `VERSION.client` + `CHANGELOG.client.md`）

包含但不限于：
- `apps/go/pkg/clientcore/**`、Go CLI、Go GUI
- `apps/mobile/android/**`、`apps/mobile/ios/**`
- 客户端 UX/文案/错误提示/状态展示、控制面调用策略

#### 两边都要改（server+client 同时发版）

包含但不限于：
- 新增/修改 server API（例如 `/session/*` 行为变更）且客户端需要配合
- 协议字段/鉴权规则变更导致任一侧单独升级会出现不兼容

### SemVer 升级规则（用于 AI 自动分配）

对 server/client 各自独立应用以下规则：
- **MAJOR**：不兼容变更（旧配置/旧客户端/旧服务端无法继续工作）
- **MINOR**：新增功能或行为增强（保持兼容）
- **PATCH**：仅修复/小优化（保持兼容）

默认倾向：在不牺牲稳定性的前提下，优先走 `PATCH`；只有新增用户可见能力再升 `MINOR`。

### 发布流程（可直接给 AI 执行）

执行时机：
- 仅在你要求时，或在准备推送/发布前执行版本号分配与 CHANGELOG 更新。

#### A. client 发布流程

1) 选择新版本号 `X.Y.Z`（按上面的规则）
2) 更新 `VERSION.client` 为 `X.Y.Z`
3) 更新 `CHANGELOG.client.md`：
   - 把 `Unreleased` 中与本次发布相关的条目整理到 `vX.Y.Z - YYYY-MM-DD`
   - `Unreleased` 保留空壳（或只保留下一轮的占位）
4) 同步“平台内部版本号”（保持可安装/可升级）
   - Android：更新 `apps/mobile/android/app/build.gradle.kts`
     - `versionName = "X.Y.Z"`
     - `versionCode` 必须递增（建议 +1）
   - iOS：更新 `apps/mobile/ios/project.yml`
     - `MARKETING_VERSION: X.Y.Z`
     - `CURRENT_PROJECT_VERSION` 必须递增（建议 +1）
     - 两个 target 的 Info.plist 若仍存在硬编码，也需要同步
5) 触发 CI 构建产物时，workflow 的 `version` 输入应填写同一个 `X.Y.Z`
   - GUI：`.github/workflows/gui-build.yml`
   - Android：`.github/workflows/android-debug.yml` / `android-build.yml`
   - iOS：`.github/workflows/ios-build.yml`
6) 打 tag（推荐）：`client-vX.Y.Z`

#### B. server 发布流程

1) 选择新版本号 `X.Y.Z`
2) 更新 `VERSION.server` 为 `X.Y.Z`
3) 更新 `CHANGELOG.server.md`（同上）
4) 同步 Node 包版本（用于追溯与 CLI 元数据）
   - `apps/node/package.json`：`version: "X.Y.Z"`
5) 打 tag（推荐）：`server-vX.Y.Z`

### CHANGELOG 写作准则（减少废话，面向用户体验）

- 每条尽量写“用户可感知变化”，不要写实现细节
- 必须写清楚：
  - 触发条件（例如“空闲超过 TTL”）
  - 影响（例如“需要手动重启才能恢复/已修复为自动恢复”）
  - 兼容性（是否需要 server+client 同时升级）
