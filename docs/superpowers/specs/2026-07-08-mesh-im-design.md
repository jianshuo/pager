# Mesh —— 真人-人即时通讯（Pager 转型）设计

- 日期：2026-07-08
- 状态：已与用户逐节确认，待评审后转实现计划
- 基础：在现有 `pager` 仓库上**改造**（复用 CF Worker + Durable Objects + iOS SwiftUI IM + WebSocket + 消息/会话基建），砍掉 daemon / @AI / 远程指挥 Claude Code 那一整套。

## 1. 目标与背景

Pager 原本是「用 IM 的方式远程指挥 Claude Code」。现转向 **Mesh**：一个**真正的人-人即时通讯 app**——用户在中心服务器注册账号、登录、单向加好友、1:1 聊天、建群、往群里拉人，消息实时到达在线设备、离线走 APNs 推送。中心服务器暂用 Cloudflare（现有 CF 账号，可挂 `mesh.jianshuo.dev`）。

三个已确认的定调决策：
1. **改造现有代码**（不新建仓库）。
2. **用户名 + 密码**注册/登录；**用户名即 user id**，别人靠它搜到你。
3. **单向加好友即可聊**（无需对方同意；好友是「我的通讯录」，单向）。

## 2. 范围

| 这一版**做** | **不做**（保留代码 / 推迟 v2） |
|----|----|
| 用户名+密码 注册/登录（session token） | daemon / @AI / 机器 / 远程指挥 Claude Code（代码保留，入口下线） |
| 单向搜索加好友 + 好友列表 | 好友请求/同意（单向模型不需要） |
| 1:1 聊天（确定性会话） | 头像、已读回执、撤回、图片/语音消息（先纯文本跑通） |
| 建群、任意成员拉人、退群 | 踢人 / 群管理员权限 |
| 实时消息扇出（WS）+ 离线 APNs 推送 | 密码找回（无邮箱/短信；忘密码只能重置账号） |
| 服务端按登录身份盖 author（防冒名） | 名片二维码加好友（v2） |

## 3. 架构：三种 Durable Object

关键重构点：现有 hub 是**单例 UserDO**（所有人共享一个「user」空间，靠共享 CLIENT_TOKEN）。真多用户必须拆成「一人一个私有空间」。

| DO | 实例键 | 职责 |
|----|--------|------|
| **DirectoryDO** | 全局单例 `"directory"` | 用户名注册表：`username → userId`、密码 hash、session token。管注册、登录、按用户名搜人、鉴权（token→userId）。 |
| **UserDO** | 每用户 `idFromName(userId)` | 用户私有空间：好友表（我加了谁）、会话索引（我在哪些 conv）、设备表（APNs token）、该用户所有设备的 WS 实时扇出。 |
| **ConversationDO** | 每会话 `idFromName(convId)` | 一条 1:1 或群会话：消息流（seq 单调递增）+ 成员名单 + 元信息（kind、title）。**基本复用现有**。 |

**砍掉**：`MachineDO`、daemon WS（`/ws/daemon`）、task/permission 派发。相关代码保留在仓库但不接入路由/入口。

## 4. 数据模型

### DirectoryDO（SQLite）
- `users(user_id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, pw_hash TEXT NOT NULL, created_at INTEGER)`
  - `pw_hash` 格式：`pbkdf2$<iterations>$<base64 salt>$<base64 derivedKey>`（PBKDF2-SHA256，salt 16B，迭代 ≥100000）。
- `sessions(token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER)`
  - token 形如 `stk_<32 hex>`；一个 user 可有多条（多设备）。
- 用户名规则：小写字母/数字/下划线，3–20 字符，唯一（存前小写归一化）。
- 搜索：`SELECT user_id, username FROM users WHERE username LIKE ?||'%' LIMIT 20`（前缀匹配）。

### UserDO（每用户 SQLite）
- `friends(friend_user_id TEXT PRIMARY KEY, friend_username TEXT, added_at INTEGER)` —— 单向。
- `conversations(conv_id TEXT PRIMARY KEY, kind TEXT, title TEXT, peer_user_id TEXT, last_seq INTEGER, last_message TEXT, last_ts INTEGER)` —— 我参与的会话索引；1:1 存 `peer_user_id`，群存 `title`。
- `devices(device_token TEXT PRIMARY KEY, platform TEXT, added_at INTEGER)` —— APNs。
- WS：hibernation API，一个用户的多台设备各一条；`serializeAttachment` 挂 `{ userId }`。

### ConversationDO（每会话 SQLite，复用现有 + 调整）
- `meta`：`convId`、`kind`（`direct` | `group`）、`title`（群）、`createdBy`。
- `members(user_id TEXT PRIMARY KEY, username TEXT, joined_at INTEGER)`。
- `events(seq INTEGER PRIMARY KEY, id, ts, role, type, body_json)` —— 复用现有事件存储与盖 seq 逻辑。

## 5. 鉴权流程

- **注册** `POST /api/register {username, password}` → Directory 校验用户名格式+唯一、密码 ≥6 位 → 算 PBKDF2 hash → 铸 `userId` → 发 session token → `{userId, username, token}`。
- **登录** `POST /api/login {username, password}` → 比对 hash（PBKDF2 用同 salt/iter 重算，常数时间比较）→ 发新 token → `{userId, username, token}`。
- **鉴权**：除注册/登录外，所有请求带 `Authorization: Bearer <token>` → Worker 调 `DirectoryDO /resolve {token}` → 得 `{userId, username}`，失败 401。
- **iOS**：Keychain 存 `token`、`userId`、`username`。启动有 token 直接进主界面；无 token 弹登录/注册页。登出＝调 `POST /api/logout`（Directory 删该 token）+ 清 Keychain。

## 6. API 清单

| 方法 路径 | 说明 |
|----|----|
| `POST /api/register` | 注册，返回 token |
| `POST /api/login` | 登录，返回 token |
| `POST /api/logout` | 撤销当前 token |
| `GET /api/me` | 当前账号信息 |
| `GET /api/users?q=<username>` | 按用户名前缀搜人 |
| `POST /api/friends {userId}` | 加好友（单向，幂等） |
| `GET /api/friends` | 我的好友列表 |
| `DELETE /api/friends/:userId` | 删好友 |
| `POST /api/conversations/direct {userId}` | 找到/新建与某人的 1:1 会话，返回 convId |
| `POST /api/groups {title, members:[userId...]}` | 建群 |
| `GET /api/conversations` | 我参与的所有会话（列表） |
| `POST /api/conversations/:id/members {userId}` | 拉人进群 |
| `DELETE /api/conversations/:id/members/me` | 退群 |
| `POST /api/register-device {deviceToken}` | 注册 APNs 设备 |
| `WS /ws/client` | 认证后订阅/收发消息 |

**确定性 1:1 convId**：对两个 userId 字典序排序后拼 `dm_<a>_<b>`，`ConversationDO.idFromName` 用它 —— 保证任意两人之间只会有一条 1:1 会话，双方任一发起都命中同一个。

## 7. 消息扇出机制

1. 客户端 WS `send {convId, event}`（body 含 markdown；author 不可信）。
2. Worker 认证得 `userId/username` → 转给 `ConversationDO`。
3. ConversationDO：校验发送者是成员 → 盖 seq、写 `events` → **服务端把 event.body.author 盖成发送者 username**（防冒名）→ 读 `members`。
4. 对每个成员 `fanout`：调该成员 `UserDO /deliver {convId, event}`。
5. 每个 UserDO：更新自己的 `conversations` 索引（last_seq/last_message）→ 推给该用户在线设备的 WS；对无在线设备的成员，发 APNs 推送。
6. 建群 / 拉人 / 退群同样通过「更新每个相关成员的 UserDO 索引 + 广播一条 `system` 事件」完成。

## 8. iOS 界面改动

- **新增**：登录/注册页（首启无 token）；通讯录/好友页；搜用户名加好友页。
- **改造**：会话列表去掉顶部「机器」条与 AI 元素；建群改为从好友勾选；会话视图去掉机器/目录/权限卡/@AI pill，保留三态气泡（本人右/他人左+名+头像）、群、实时消息流与 markdown/patch。
- **设置**：昵称栏换成账号信息（用户名只读 + 登出）。
- **下线**：`pair-qr` 扫码配 token（有真登录后不需要）；`AppModel.pair`、DEBUG token 注入等一并移除或停用。
- 复用：`ClientWS`、`AppModel` 事件存储/去重/patch、`EventRowViews` 气泡、`HubAPI`（换成新端点 + Bearer session token）、`Theme`（抹茶配色保留）。

## 9. 发布

- **新 bundle id `com.wangjianshuo.Mesh`**（全新 app）。需：新建 App Store Connect app、新 App ID + 开 Push Notifications capability、match 重生分发 profile（`aps-environment: production`）、新 1024 图标、新 TestFlight 线。fastlane `BUNDLE_ID` 常量与 `project.yml` 改成 Mesh；CI 复用同 team `97XBW2A43H`、同 Cathier-certs 证书库、同 ASC API key。
- **显示名 Pager → Mesh**。现有 Pager app（6788326605）搁置不动。
- 服务端：现有 CF Worker 原地改造为 Mesh hub（DO 迁移见下），可选挂自定义域 `mesh.jianshuo.dev`。

## 10. 迁移与兼容

- **不迁移**现有 Pager 数据（单例 UserDO 的会话/机器）—— Mesh 是全新账号体系，从空库起步。旧 DO 类保留但不再路由。
- 现有 `packages/protocol` 事件信封（Event/EventDraft/seq/patch）**复用**；新增 `system` 事件类型（进群/退群提示）与账号相关 REST 契约。
- daemon 相关 wire 类型（Hello/Task/HubToDaemon）保留但不再引用。

## 11. 测试策略

- **协议层**：zod schema 单测（注册/登录请求、好友、建群、扇出事件）。
- **hub 集成**：Vitest + `unstable_dev` 或 miniflare —— 覆盖注册→登录→加好友→建 1:1→发消息→第二用户收到；建群→拉人→三方都收到；确定性 1:1 id 幂等；未认证 401；冒名 author 被服务端纠正。
- **端到端冒烟**：node 脚本模拟两个真实客户端（各自注册、加好友、互发），断言双向送达（替换现有 `hub/scripts/smoke.mjs`）。
- **iOS**：登录流、会话列表渲染、气泡三态的既有测试延续；WS 收发用假 client 验证。

## 12. 里程碑（供实现计划切分参考）

1. 协议：账号/好友/群/system 事件的 schema + REST 契约。
2. DirectoryDO：注册/登录/搜人/鉴权 + PBKDF2。
3. UserDO 重构：从单例改每用户；好友表、会话索引、设备、WS 扇出。
4. ConversationDO：成员制 + 服务端盖 author + 扇出到多 UserDO。
5. Worker 路由：新 REST + `/ws/client` 认证换 session token；下线 daemon 路由。
6. iOS：登录/注册页 + Keychain 会话 + HubAPI 换端点。
7. iOS：好友（搜索/加/列表）+ 1:1 会话入口。
8. iOS：建群/拉人/退群 + 会话视图去 AI 化。
9. 发布：Mesh bundle id + App ID/push + fastlane/CI + TestFlight。
