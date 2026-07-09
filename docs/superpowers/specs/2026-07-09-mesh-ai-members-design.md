# Mesh AI 成员设计（把 AI 作为会话成员接回来）

- 日期：2026-07-09
- 状态：已与用户逐节确认，待评审后转实现计划
- 前置：Mesh 人-人 IM（`docs/superpowers/specs/2026-07-08-mesh-im-design.md`）已上线。本设计在其"成员制会话"之上，把 AI 作为一种特殊成员接回来——复用 Pager 时代休眠的 daemon/权限/流式代码。

## 1. 目标

让 AI 以**平级成员**的身份回到 Mesh：可私信、可拉进群、和真人在同一条时间线上。两类：
- **内置聊天 bot：Claude（Anthropic）、ChatGPT（OpenAI）**——hub 直连各自 API，永远在线，人人可用。
- **自建干活 bot**——绑一台你的机器 daemon（Claude Code），能读文件/跑命令/改代码，只有创建者能批准其操作。

核心理念（回到最初 3A）：**人和 AI 织成一张网**——一个群里可同时有多个真人 + 多个 AI。

## 2. 范围（分两期，都要但先稳）

**A 期 — 聊天 bot（Claude / ChatGPT，纯 hub）**
- 预置 Claude、ChatGPT 两个 bot 账号，通讯录常驻，人人可 DM / 群里 @。
- hub 拉会话最近历史 → 调 Anthropic / OpenAI 流式 API → 以 bot 身份流式回话（patch）。
- 不碰 daemon。永远在线。**先落这期。**

**B 期 — 干活 bot（daemon / Claude Code）**
- 用户创建 bot、绑机器+目录；接回休眠的 daemon/`/ws/daemon`/MachineDO。
- 复用 Pager 的 task/session/permission_request/patch。
- 操作审批：**只有 bot 主人**能点允许/拒绝，卡片群里可见只读。

**不做（v2+）**：bot 之间自动对话（防死循环，bot 只回真人消息）、bot 主动发起、跨会话记忆/长期记忆、多模态、按 bot 计费/限流面板。

## 3. 核心抽象

**一个 AI 成员 = 一个 Directory 账号（`userId`，`kind=bot`）+ 一个后端描述符。** 它进会话、进群、消息扇出全走跟真人一样的机制；只在"投递"分叉——发给 bot 的消息不推手机，而是调它的后端生成回复，回复再作为该成员的消息 ingest 回 ConversationDO，扇给所有人。

后端描述符（存 Directory `bots` 表）：
- `kind: "claude" | "chatgpt" | "agent"`
- 聊天类（claude/chatgpt）：`model`（如 `claude-opus-4-8` / `gpt-5`）、`systemPromptExtra?`
- agent 类：`ownerId`、`machineId`、`dir`

## 4. 数据模型

### DirectoryDO
- `users` 加列 `kind TEXT NOT NULL DEFAULT 'human'`（`human` | `bot`）。
- 新表 `bots(user_id PK, backend TEXT, model TEXT, owner_id TEXT, machine_id TEXT, dir TEXT)`。
- 预置：部署时确保 `usr_bot_claude`、`usr_bot_chatgpt` 存在（固定 id，`kind=bot`，无密码不可登录）。
- `/register` 拒绝保留用户名 `claude`/`chatgpt`（防冒名）。搜索/解析对 bot 一视同仁（能被搜到、加进群）。

### ConversationDO
- `members` 表已有 `user_id, username`；bot 作为成员直接躺里面，无需改结构。加一处判断：ingest 后做"bot 派发"（见 §6）。

### UserDO（每个 bot 也有一个 UserDO 实例）
- bot 的 UserDO 只用来存它参与的会话索引（`conversations`）——这样 `directConversation` 的确定性 id、群成员扇出都无需特判 bot。bot 无设备、无 WS（不推送）。

## 5. 唤起 + 上下文

- **私信 bot（direct）**：每条人类消息都触发该 bot 回复。
- **群（group）**：仅当消息 `@<botUsername>` 且该 bot 是群成员时触发；一条可 @多个 bot，各自回。
- **只回真人**：bot 仅响应 `role=user` 且作者为人类的 text 消息，**不响应其它 bot 的消息**（防死循环）。
- **上下文**：回复前拉本会话最近 N 条事件（按 token 预算，约 30 条/上限），构造成带发言人标注的历史；system 提示告知"你是 <BotName>，在一个多人群里/私聊中"。
- **每会话独立语境**；agent bot 额外用 Claude Code `session` 跨消息 resume（一个会话一个 session）。

## 6. 路由：ingest 后的"bot 派发"

`ConversationDO.ingest` 存档 + 扇给真人后，新增：
```
addressed = 找出被叫到的 bot 成员（direct: 唯一 bot；group: 被 @ 的 bot 成员）
for bot in addressed（且当前事件是人类 text）:
  descriptor = Directory.bot(bot.userId)
  if descriptor.backend in {claude, chatgpt}:  ctx.waitUntil(hubRespond(conv, bot, descriptor))
  else if descriptor.backend == agent:          deliverTask(descriptor.machineId, conv, bot, event)
```

**hubRespond（聊天 bot，不阻塞 ingest）**
1. 拉最近历史 → 组装 messages（人类=user、该 bot 过往=assistant、群里其他人名字进 content）。
2. 先以 bot 身份 ingest 一条空 `text`（role=`agent`, author=botUsername）→ 拿到 seq/id。
3. 调 Anthropic / OpenAI **流式** → 边收边对该 event 发 `patch` 覆盖 markdown。
4. 失败 → patch 成一句报错文案（不崩会话）。

**deliverTask（agent bot）**：复用 `MachineDO.deliver({kind:"task", conv, dir, agent, event})`；daemon 跑 Claude Code（按 conv resume session），流回 text/tool_card/permission_request/status/patch，均以 bot 身份 ingest + 扇出。

## 7. 流式显示

复用现成 `patch`：hub/daemon 不断发 `patch(conv, eventId, markdown)` 覆盖那条 text 事件的正文，iOS 端 `AppModel.applyPatch` 已处理 → AI"打字"实时可见。无需新机制。

## 8. Agent bot 审批（只有主人能批）

- daemon 发 `permission_request`（老协议）→ ingest 成 bot 成员的权限事件 → 扇给所有人 → 都看到琥珀卡。
- **事件体带 `owner_id`**（bot 的 ownerId）。iOS `PermissionRequestCard`：仅当 `Keychain.userId == owner_id` 才渲染可点的允许/拒绝；否则只读"等 <owner> 批准"。
- 主人点 → `POST /api/permission-response` → hub → `deliver(user_event: permission_response)` 给 daemon（老流程原样）。
- 复用：整套 permission_request/response 协议 + 琥珀卡 UI（都还在，Mesh 重写时保留未删）。

## 9. iOS 改动

- **通讯录**：顶部常驻"助手"区，列 Claude / ChatGPT（无需加好友，点开即 `directConversation`）；下面才是真人好友。
- **建干活 bot**：新入口（设置或通讯录）→ 起名 + 选在线机器 + 目录 → hub 铸 bot 账号 + 存 descriptor + 绑定；建好出现在通讯录"我的 bot"。
- **@选成员**：群输入框打 `@` 弹群成员（含 bot）选择，插入 `@username`。
- **气泡**：bot 消息 role=`agent` → 复用 AI 气泡（现有），显示 bot 名 + 头像；不同 bot 用不同头像/色。
- **权限卡**：按 §8 门控到 owner。
- **daemon 接回**：B 期重新启用本机 daemon 连 `/ws/daemon`（现在空跑连不上）。

## 10. 复用 vs 新增

**复用（唤醒休眠代码）**：MachineDO、`/ws/daemon` 路由、daemon(Claude Code)、`HubTask`/`HubToDaemon`、permission_request/response、patch 流式、琥珀权限卡、AI 气泡。

**新增**：
- DirectoryDO：`users.kind`、`bots` 表、预置 Claude/ChatGPT、保留名保护、`bot(userId)` 查询。
- ConversationDO：bot 派发（§6）、@bot 检测、只回真人。
- hub 后端：`responder/anthropic.ts` + `responder/openai.ts`（流式 → patch）；历史→messages 组装。
- Worker secrets：`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`。
- 路由：`POST /api/bots`（建 agent bot）、`GET /api/bots`（我的 bot + 内置）、`/api/permission-response` 接回。
- iOS：通讯录助手区、建 bot、@选成员、权限卡门控、daemon 接回。

## 11. 密钥与成本

- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` 存 Worker secret（`wrangler secret put`）。默认模型：Claude→最新 Opus/Sonnet；ChatGPT→最新 GPT。
- 成本护栏：bot 只回真人消息、群里必须 @；上下文按 token 预算截断。按 bot/用户限流留 v2。

## 12. 测试策略

- **协议**：bot 成员/`kind`、permission owner 字段 schema。
- **hub 集成（miniflare）**：direct 与 bot 建会话→发消息→（mock LLM）→ bot 以 agent 身份 ingest + patch 流；群里 @bot 才触发、不@不触发；bot 不回 bot；agent bot 派发走 MachineDO（假 daemon）+ 权限事件带 ownerId。LLM API 调用注入可 mock 的 responder。
- **端到端冒烟**：真 Anthropic/OpenAI key 各发一条 DM，断言收到流式回复。
- **iOS**：AI 气泡渲染、权限卡 owner 门控、@选成员、通讯录助手区。

## 13. 里程碑

**A 期（聊天 bot）**
1. Directory：`kind` + `bots` 表 + 预置 Claude/ChatGPT + 保留名。
2. responder：Anthropic + OpenAI 流式模块（可 mock）。
3. ConversationDO：bot 派发 + @检测 + 只回真人 + hubRespond（ingest 空 text→patch 流）。
4. 历史→messages 组装 + system 提示。
5. 路由 `GET /api/bots`；Worker secrets。
6. iOS：通讯录助手区、AI 气泡、@选成员。
7. hub 集成 + iOS 测试；端到端冒烟。

**B 期（干活 bot）**
8. Directory：agent bot descriptor（owner/machine/dir）；`POST /api/bots`。
9. 接回 `/ws/daemon` + MachineDO + deliverTask；daemon 重新连 Mesh hub。
10. permission_request 带 ownerId + iOS 权限卡门控 + permission-response 接回。
11. iOS：建干活 bot 流程；session resume 对齐。
12. 集成（假 daemon）+ 端到端（真 daemon）。
