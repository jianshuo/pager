# Pager — Agent IM 设计文档

日期：2026-07-07
状态：已与用户（王建硕）逐节确认

## 一句话

一个原生 iOS IM app，联系人是「跑着 agent 的机器」（Mac、VPS…），会话是 Claude Code 的工作 session。远程发任务、实时看工具调用、在锁屏通知上批准权限、任务完成收推送。协议 agent 无关，为语音、看板、Codex、定时任务留好口子。

## 背景与动机

用户已有 lab.jianshuo.dev（Claude Agent SDK 网页聊天）和 codex.jianshuo.dev（Codex 网页聊天），但它们都是「单机器、单网页、无推送」。Pager 的差异在于 IM 三要素：**会话是持久的、多个的、有推送的**。核心刚需：Claude Code 在家里的 Mac 上跑长任务时，人在外面能看到进展、能被推送叫回来批准权限、能追加指令。

## 已确认的关键决策

| 决策点 | 选择 |
|--------|------|
| agent 所在地 | Mac 和 VPS 都接入，每台机器一个 daemon，多机器架构 |
| 客户端形态 | 原生 iOS app（SwiftUI），复用 Cathier/VoiceDrop 的 fastlane+TestFlight 流水线 |
| 会话来源 | IM 自己开的会话（daemon + Claude Agent SDK），不镜像终端里手动开的会话 |
| 中枢 | Cloudflare Workers + Durable Objects |
| v1 范围 | 基本聊天 + 权限批准推送 + 工具调用可视化 + 新建会话选机器/目录 + 完成/需输入推送 |
| 扩展方向（留口子，不做） | 语音输入/播报（火山 ASR/TTS）、多 agent 看板、接 Codex/Gemini 等其他 agent、定时/自动触发任务 |
| 架构方案 | A：瘦中枢 + 胖 daemon——翻译层在 daemon，中枢只存储/转发/推送，app 只认通用协议 |

方案 A 的理由：手机 app 发版要过 App Store 审核，是全链路最慢的一环；把易变的 agent 适配逻辑放在 daemon（git pull 即更新），app 只认稳定协议，「不断加新功能」才不被审核卡脖子。以后接 Codex = daemon 加一个 adapter，中枢和 app 一行不改。

## 第 1 节：事件协议与数据模型

三层名词：

- **Machine（机器）**：一台跑 daemon 的主机，有 id、名字、在线状态。IM 里的「联系人」。
- **Conversation（会话）**：一次任务对话，属于某机器 + 某项目目录，挂一个 agent session（v1 = Claude Code session id，可 resume 续聊）。
- **Event（事件）**：会话里一条只追加的记录。手机 ↔ 中枢 ↔ daemon 之间传的全是它。

### Event 通用信封

```json
{
  "id": "evt_...",
  "conv": "cnv_...",
  "seq": 42,
  "ts": 1751780000,
  "role": "user | agent | system",
  "type": "text | tool_card | permission_request | permission_response | status | error",
  "body": { "...按 type 定义..." },
  "agent": "claude-code"
}
```

`agent` 字段为多 agent 扩展预留。`seq` 是**每会话单调递增序号**，由 ConversationDO 统一分配；客户端断线重连后按「我最后见到的 seq」增量补齐——消息不丢不重的根基。

### 各 type 的 body

- **text**：`{ markdown: "..." }`。用户消息和 agent 回复共用。流式回复时同一 `id` 多次 patch（WebSocket 上传增量），落库只存最终版。
- **tool_card**：`{ tool: "Bash|Edit|Read|...", title: "npm test", summary: "一行人话", detail: "完整命令/输出", diff?: "unified diff" }`。daemon 负责把原始工具调用压成人话标题 + 可折叠详情；手机端不需要懂任何具体工具。
- **permission_request**：`{ request_id, tool, description, options: ["allow", "deny", "allow_always"] }`。
- **permission_response**：`{ request_id, choice }`。手机（app 内按钮或锁屏通知 action）发出。超时（可配置，默认 1 小时）daemon 自动 deny 并补一条 status 说明。
- **status**：`{ state: "thinking|running|waiting_input|done|failed", note?: "..." }`。驱动会话列表状态点和推送文案。
- **error**：`{ message, recoverable: bool }`。

### 终审补充决策（2026-07-07，01-protocol 落地时定）

- **前向兼容通道**：daemon（git pull 秒更）和 hub（wrangler 部署）演进速度不同，hub 的存储/转发路径不得拒绝新 daemon 发来的未知事件类型。协议包额外导出 `EventLoose` / `EventDraftLoose`（envelope 严格、type/body 不设限），hub 存转用宽松信封，客户端对未知 type 做通用卡片降级（见第 4 节）。`DaemonHello` 携带 `proto` 协议版本号，供 hub 检测失配。
- **机器上下线广播**：`HubToClient` 增加 `machine_status` 消息（`{ machine, online }`），支撑首页机器在线横条的实时更新，不靠轮询 /api/machines。

### 推送规则（Worker 端裁决）

- `permission_request` → 高优先级、带「允许/拒绝」action 按钮的可交互推送。
- `status: done | failed | waiting_input` → 普通推送。
- 其余事件不推。客户端 WebSocket 在线时一律不推（避免重复打扰）。

## 第 2 节：Daemon（每台机器一个）

Node + TypeScript 进程。Mac 上 launchd 常驻（注意已知坑：launchd 任务的脚本/数据放本地目录，不放 iCloud），VPS 上 systemd 常驻（照搬 lab/codex 的 provision 套路）。

职责：

1. **注册与心跳**：启动时用机器 token 连中枢 `/ws/daemon`（落到自己的 MachineDO），断线指数退避重连。中枢由此维护机器在线状态。
2. **会话执行**：收到「新会话（目录 X，首条消息 Y）」→ 在目录 X 用 `@anthropic-ai/claude-agent-sdk` 起 session；后续消息 → resume 续聊。并发上限可配置：Mac 默认 4，1GB VPS 默认 1。超限的新任务排队并回一条 status 说明。
3. **翻译（adapter 层）**：`adapters/claude-code.ts` 把 SDK 事件流翻成第 1 节的 Event 协议。adapter 接口固定（`start / resume / interrupt / onEvent`），以后 `adapters/codex.ts` 平行新增。
4. **权限桥接**：用 SDK 的 `canUseTool` 回调把权限请求转成 `permission_request` 事件上行，await 手机的 `permission_response`（或超时 deny）。`allow_always` 落到该会话的 session 内白名单。
5. **目录上报**：把配置声明的项目目录白名单（如 `~/code` 下一层子目录）上报 MachineDO，供手机新建会话时选择。

**配置** `daemon.json`（600 权限）：中枢 URL、机器名、机器 token、目录白名单、并发数、权限超时。Claude 认证直接复用本机已登录的 Claude Code 凭证，daemon 不保存任何 API key。

## 第 3 节：中枢（Cloudflare Workers + Durable Objects）

一个 Worker 项目，三个部件：

- **Worker（无状态入口）**：HTTPS API + WebSocket 升级。路由：
  - `/ws/daemon` — 机器连（认证：机器 token）
  - `/ws/client` — 手机连（认证：客户端 token）
  - `/api/conversations` — 会话列表 / 新建
  - `/api/machines` — 机器列表 + 各自目录白名单 + 在线状态
  - `/api/register-device` — 上报 APNs device token
  - `/api/permission-response` — 锁屏通知 action 的回调入口（不开 app 也能批准）
- **ConversationDO（每会话一个）**：会话单一真源。盖 `seq` 号 → 存 DO 内置 SQLite → 双向转发（daemon ↔ 所有在线客户端）→ 客户端不在线时按推送规则调 APNs。DO 天然串行，无并发烦恼。
- **MachineDO（每机器一个）**：维持 daemon WebSocket、在线状态、目录列表；新会话时把任务派给 daemon；daemon 掉线时广播机器离线。

**存储**：事件存 ConversationDO 自带 SQLite（单 DO 上限 10GB，单会话绰绰有余）；会话/机器索引存全局 D1 表（首页列表查询用）。旧会话归档 = 删除该 DO 数据 + D1 标记。

**02-hub 计划补充决策（2026-07-07）**：
- **客户端单 WS**：手机只连一条 WS 到 **UserDO**（单用户单例），事件/patch/machine_status 全从这条下发，`subscribe {conv, afterSeq}` 按会话补历史；ConversationDO 退化为纯「盖 seq + 存储」，不持有 socket。推送裁决（客户端是否在线）也移到 UserDO。
- **去 D1**：会话/机器索引存 UserDO 自己的 SQLite，不建 D1。
- **认证从简**：v1 用两个静态 Bearer token（`DAEMON_TOKEN` / `CLIENT_TOKEN`，wrangler secret）；第 5 节的配对码流程推迟到 04-ios 实施。
- **APNs 延迟配置**：推送代码与测试在 02-hub 完成；生产 secrets（.p8/bundle id）到 04-ios 再配，未配置时推送静默跳过。

**APNs**：Worker 用 fetch 直调 APNs HTTP/2 API，JWT 用 .p8 key 签（key 在用户 iCloud 重要文档目录，部署时放进 Worker secret）。不引第三方推送服务。

**成本**：单用户，Workers 付费版 $5/月（DO 需要付费版），预计不超。

## 第 4 节：iOS App（SwiftUI）

信息结构照微信：

- **首页 = 会话列表**：每行一个 Conversation——机器名+目录、最后一条摘要、状态点（🟢 running / 🟠 waiting_input 或 permission / ⚪️ done / 🔴 failed）、未读数。顶部横条显示各机器在线状态。这一页就是未来「多 agent 看板」的雏形。
- **会话页 = 气泡流**：用户消息靠右；`text` 渲染 markdown（流式逐字上屏）；`tool_card` 可折叠卡片（一行标题，展开看输出/diff，diff 语法高亮）；`permission_request` 带按钮卡片，批准后变已决态。
- **新建会话**：选机器（在线亮/离线灰）→ 选目录（daemon 上报的白名单）→ 输首条消息。
- **连接模型**：前台 WebSocket 直连收流式事件；退后台断开，靠 APNs 唤醒；回前台按 seq 补历史。本地 SQLite 缓存已读事件，翻历史不等网络。
- **锁屏批准**：`permission_request` 推送带 UNNotificationAction「允许/拒绝」，action 直接打 `/api/permission-response`，不必开 app。
- **预留口子**：输入框旁留麦克风按钮位（v2 火山 ASR）；事件渲染器按 `type` 分发，**未知 type 渲染成通用卡片**（显示 title/摘要），保证 daemon 先行加新事件类型时老 app 优雅降级。
- **发布**：fastlane + GitHub Actions → TestFlight（复用 Cathier 流水线模板）。

## 第 5 节：安全

- **手机 ↔ 中枢**：首次配对用一次性配对码（daemon 命令行生成，手机输入换长期客户端 token），token 存 Keychain。单用户系统，无账号体系。
- **daemon ↔ 中枢**：每机器一条长期 token，provision 时写入 `daemon.json`（600）。
- **爆炸半径**：中枢被攻破 ≠ 机器被攻破。daemon 只接受一种指令——「在白名单目录里开/续 Claude 会话」，没有任意命令通道；真正的命令执行权限仍由 Claude Code 自身权限体系把关，批准按钮在用户手机上。
- Claude 订阅 ToS 单用户，token/密码不分享（同 lab/codex 纪律）。

## 第 6 节：错误处理与测试

**错误处理**：

- daemon 掉线 → 机器灰、其进行中会话标 failed；daemon 重连后若 SDK session 仍可 resume 则恢复 running。
- 手机掉线无感知成本，回前台按 seq 补齐。
- APNs token 失效（410）自动清理重新等注册；权限推送丢失不致命——事件仍在 DO，开 app 即见待批准卡片。
- 流式 patch 丢失：落库只存最终版，重连补历史时拿到的就是完整消息。

**测试**：

- adapter：录制真实 Claude Agent SDK 事件 JSONL 做 fixture 回放测试（codex-agent 已验证过此法）。
- 中枢：Vitest + miniflare 测 DO 的 seq 分配、转发、推送裁决。
- 协议：zod schema 双端共享校验（daemon 与 Worker 同一 npm 包；Swift 侧按 schema 手写 Codable + 快照测试）。
- 端到端：Mac daemon + TestFlight 真机自用（吃狗粮）。

## 仓库结构（monorepo）

```
pager/
  packages/protocol/   # zod schema + TS 类型（daemon 与 hub 共享）
  daemon/              # Node daemon（adapters/ 在此）
  hub/                 # Cloudflare Worker + DO
  ios/                 # SwiftUI app
  docs/superpowers/    # specs / plans
```

## 明确不做（v1）

- 不镜像终端里手动开的 Claude Code 会话。
- 不做多用户/账号体系。
- 不做 Android / Web 客户端。
- 语音、看板增强、Codex adapter、定时任务——只留接口不实现。
