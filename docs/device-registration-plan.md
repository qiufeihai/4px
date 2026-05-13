# 设备注册模型设计 TODO

状态：未实现，仅作为后续落地方案草案。

适用范围：`apps/node` 服务端、`apps/go/pkg/clientcore`、`apps/go/gui`、`apps/mobile/android`，以及仍在维护的 `apps/node` client。

## 背景

当前设备限制已经切换为按客户端稳定 `x-device-id` 计数，旧版不再兼容。这种方案对官方客户端足够简单，但仍然属于“客户端声明身份，服务端做限制”的模型。

该模型存在天然边界：

- 拿到合法 `auth token` 的人，可以自行构造请求头并伪造新的 `x-device-id`
- 魔改客户端可以伪装成已有设备，或反复制造“新设备”
- `device_id` 一旦只由本地持久化生成，清数据、重装、脚本调用都可能绕过设备上限

如果后续要把“设备数限制”提升为真正的商业约束和防绕过能力，需要引入服务端认可的设备注册模型，而不是继续依赖客户端自报字符串。

## 目标

- 设备限制按“服务端已登记设备”生效，不再按客户端临时声明字符串生效
- 同一账号的设备数量由服务端设备档案统一管理
- 新设备不能仅靠更换 `x-device-id` 绕过上限
- 设备身份可用于 `/proxy`、`/session/ping`、`/session/offline`
- 支持显式解绑、换机、丢设备后人工恢复
- 在保留高防绕过能力的前提下，尽量不影响现有数据面性能

## 非目标

- 不追求绝对不可破解；root/jailbreak、内存注入、系统级代理劫持仍不在完全防御范围
- 不做重量级 DRM 或硬件 attestation 首版方案
- 不在 `/proxy` 请求上引入明显高频数据库查询
- 不要求首版同时解决支付、订阅、账号风控等商业逻辑

## 威胁模型

后续设计至少要覆盖以下场景：

- 用户共享 `auth token` 给他人使用
- 用户魔改官方客户端，自定义 `x-device-id`
- 用户自写脚本直接调用 `/proxy`
- 用户清缓存、重装应用后试图伪装成新设备
- 用户在多端间复制配置文件

可以接受但要记录的场景：

- 设备丢失后，攻击者已拿到完整本地私钥和 token
- 高权限系统环境下的动态 hook 和内存窃取

## 总体思路

核心原则：服务端不再信任“客户端说自己是谁”，而是只信任“服务端登记过的设备记录 + 该设备私钥对 challenge 的签名证明”。

推荐采用两阶段模型：

1. 阶段一：服务端设备注册表
2. 阶段二：设备 challenge/response 签名认证

不建议继续在现有 `device_ticket` 上叠更多补丁；如果后续上设备注册模型，应以新模型替代现在的弱状态层。

## 阶段一：服务端设备注册表

### 客户端首次启动

- 客户端本地生成一对设备密钥：
  - `device_private_key`
  - `device_public_key`
- 私钥仅保存在本地安全存储：
  - macOS GUI：Keychain
  - Android：Keystore 或加密后的 SharedPreferences
  - Node client：本地文件，至少配合权限收紧
- 同时生成稳定本地 `device_install_id`
  - 仅用于本地显示和辅助排查
  - 不再直接作为服务端最终设备身份

### 设备注册接口

新增建议接口：

- `POST /device/register`
- `POST /device/renew`
- `POST /device/unregister`
- `GET /device/list`
- `POST /device/challenge`

首版最少只需要：

- `POST /device/register`
- `POST /device/unregister`
- `GET /device/list`

### 注册请求字段

- `auth token`
- `device_public_key`
- `device_name`
- `platform`
- `app_version`
- `install_fingerprint`

其中：

- `device_name` 用于管理台展示，例如 `MacBook Air`、`Pixel 8`
- `platform` 取值建议固定：`macos`、`android`、`ios`、`node`
- `install_fingerprint` 只用于辅助风控与排查，不能作为安全根

### 服务端注册结果

服务端创建一条设备记录，并返回：

- `device_record_id`
- `device_status`
- `registered_at`
- 可选的短期会话令牌

### 设备记录建议字段

- `id`
- `user_id`
- `public_key`
- `platform`
- `device_name`
- `app_version`
- `status`
- `created_at`
- `last_seen_at`
- `last_ip`
- `last_user_agent`
- `revoked_at`
- `note`

### 状态定义

- `active`：已注册，可正常使用
- `revoked`：已注销，不允许继续使用
- `replaced`：因换机或主动替换而失效
- `blocked`：后台人工封禁

## 阶段二：challenge/response 签名认证

### 基本流程

1. 客户端带 `auth token + device_record_id` 请求 challenge
2. 服务端返回：
   - `challenge_id`
   - `nonce`
   - `expires_at`
3. 客户端用本地私钥对 challenge 签名
4. 客户端在 `/proxy` 或 `/session/ping` 请求里提交：
   - `device_record_id`
   - `challenge_id`
   - `signature`
5. 服务端用该设备记录里的公钥验签
6. 验签通过后，才承认该请求来自这台已注册设备

### 为什么要 challenge

- 避免简单重放历史签名
- 避免只拷贝设备记录 ID 就能冒充设备
- 让服务端掌握短期有效的身份证明窗口

### challenge 生命周期建议

- 默认有效期 30 秒到 120 秒
- 单次使用后立即失效
- 每个设备只保留少量未消费 challenge，防止状态膨胀

## `/proxy` 与控制面的接入方式

### 方案建议

不要在每个 `/proxy` 请求都先走一次独立注册查询。推荐：

1. 首次连接或 challenge 过期时，请求新 challenge
2. `/proxy` 请求直接带签名证明
3. 服务端优先基于内存缓存校验 challenge 状态
4. Redis 或持久化存储只承担低频同步和恢复

### `/session/ping`

- 继续负责在线续租
- 顺便刷新最近在线时间
- 可在 ping 响应中告知 challenge 即将过期，客户端提前续签

### `/session/offline`

- 继续负责显式释放在线占用
- 不直接删除设备记录，只标记设备离线

## 设备上限策略

设备上限不再由“当前看到几个不同 `device_id`”决定，而由设备注册表决定。

建议区分两个概念：

- `registered_devices`：已登记设备数
- `active_sessions`：当前在线设备数

首版建议限制 `registered_devices`，而不仅限制在线数。这样更能防止无限注册刷设备。

### 推荐策略

- 当 `registered_devices >= maxDevices` 时，拒绝新设备注册
- 旧设备仍可继续使用
- 用户必须先解绑旧设备，才能注册新设备

可选扩展：

- 允许“替换最久未活跃设备”
- 允许后台强制踢下线并替换

## 数据存储建议

### 必需存储

- `device_records`
- `device_challenges`
- `device_sessions`

### 存储层建议

- 单机场景可先用本地文件或 SQLite 做 PoC
- 真正上线建议直接用 Redis + 持久数据库组合

推荐职责：

- Redis：challenge、在线会话、短期缓存
- 持久数据库：设备记录、状态、解绑历史

如果没有持久数据库，设备注册模型会在重启、换机、恢复流程上变得很脆弱。

## 客户端改造点

### Go clientcore

- 增加本地密钥生成与持久化
- 增加设备注册流程
- 增加 challenge 获取与签名逻辑
- 改造 `/proxy`、`/session/ping`、`/session/offline` 请求头
- 增加“设备被撤销”“设备需重新注册”等错误处理

### GUI

- 在设置页或状态页展示：
  - 当前设备名
  - 当前设备状态
  - 是否已注册
- 提供复制设备 ID、重置设备注册、查看最近错误等调试能力

### Android

- 使用系统安全存储保存私钥
- 重装后的设备恢复策略要单独定义
- 连接失败时要明确区分：
  - 设备上限
  - 设备被注销
  - 签名失败
  - challenge 过期

### Node client

- 若继续保留，至少实现同样的注册与签名链路
- 如果不再重要，可考虑后续降级为内部调试用途，避免长期维护多套安全逻辑

## 服务端改造点

### `apps/node`

- 新增设备注册控制面接口
- 新增设备记录存储抽象
- 新增 challenge 生成与验签逻辑
- 在 `/proxy` 上加入设备记录校验和挑战校验
- 在 `/session/ping` 刷新设备最近在线与活跃状态
- 在 `/session/offline` 释放活跃会话

### 管理后台

建议新增“设备管理”页面，至少包含：

- 用户的已注册设备列表
- 平台、设备名、最近在线时间
- 当前在线状态
- 手动解绑
- 强制失效 challenge / session

## 迁移步骤建议

### 第 0 步：文档与接口冻结

- 冻结设备注册协议字段
- 冻结错误码和响应语义
- 明确旧版客户端升级窗口

### 第 1 步：服务端先引入设备记录表

- 先不强制启用
- 仅记录新客户端注册信息
- 观测设备记录和现有设备数限制是否一致

### 第 2 步：客户端支持注册

- Go clientcore
- GUI
- Android
- Node client

成功标准：

- 新客户端可注册并正常连通
- 老客户端仍走旧逻辑

### 第 3 步：服务端灰度开启“已注册设备优先”

- 对白名单用户先启用
- 记录拒绝原因和失败日志
- 验证换网、重启、重装等场景

### 第 4 步：启用 challenge 验签

- 首先在 `/session/ping` 验证
- 稳定后再用于 `/proxy`
- 观察性能和失败率

### 第 5 步：彻底下线旧 `device_id` 模式

- 删除旧请求头兼容
- 删除旧设备限制逻辑
- 删除现有 `device_ticket` 逻辑

## 错误码建议

- `missing_device_record`
- `device_registration_required`
- `device_limit_exceeded`
- `device_revoked`
- `device_signature_invalid`
- `device_challenge_expired`
- `device_challenge_replayed`
- `device_registration_conflict`

要求：

- 所有客户端都要对这些错误给出明确中文提示
- 管理后台日志要能看到具体拒绝原因

## 测试清单

### 功能测试

- 首次注册成功
- 重启后同设备继续成功
- 第二台设备超过上限被拒绝
- 已注册设备可重复连接
- 手动解绑后可重新注册

### 异常测试

- challenge 过期
- challenge 重放
- 签名错误
- 服务端重启
- Redis 重连
- 客户端本地密钥丢失
- 客户端重装

### 对抗测试

- 手工改 `device_record_id`
- 复制配置到另一台机器
- 复制 `auth token` 但没有私钥
- 复制旧 challenge 重放

## 性能注意点

- 不要在每个 `/proxy` 请求上做慢数据库查询
- challenge 状态要走内存或 Redis
- 验签算法优先选开销可控方案，例如 Ed25519
- 日志必须限频，避免异常风暴拖慢数据面

## 回滚策略

需要明确保留以下回滚开关：

- 关闭 challenge 强校验，只保留设备注册
- 仅对部分用户启用设备注册
- 服务端临时退回当前 `x-device-id` 模式

注意：真正切到新模型前，不要提前删除旧链路。必须等灰度和双写观测完成。

## 开放问题

- 设备名是否允许用户自定义修改
- 重装应用是否视为新设备
- 同一终端多安装实例是否允许共存
- 管理后台是否允许用户自助解绑
- 是否要支持“替换最久未活跃设备”
- 是否需要为 iOS 单独设计更严格的密钥迁移策略

## 推荐落地顺序

后续真做时，建议严格按以下顺序推进：

1. 先做设备记录表和注册接口，不做 challenge
2. 先让新客户端能注册并展示设备列表
3. 先解决解绑、换机、丢设备恢复流程
4. 再引入 challenge 签名
5. 最后删除当前 `device_ticket` 和旧 `x-device-id` 直通逻辑

这个顺序的原因是：难点不在签名，而在设备生命周期和用户恢复流程。如果这些流程没定义好，签名做得再强也会把正常用户锁死。
