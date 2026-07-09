# Mesh AI 成员 · B 期（自建干活 bot / daemon）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户创建"干活 bot"——绑一台机器 + 目录，背后是 Claude Code(daemon)，能读文件/跑命令/改代码；被拉进会话 @ 或私信时干活，操作审批**只有 bot 主人**能点。

**Architecture:** 唤醒休眠的 daemon 链路（`/ws/daemon` + MachineDO + HubTask/DaemonEvent/permission）。ConversationDO 派发时 backend=agent → `deliverTask` 给绑定机器的 MachineDO → daemon 跑 Claude Code、流回事件；MachineDO 把事件以 bot 身份(author=botUsername) ingest 回会话，permission_request 附 `owner_id` 供 iOS 门控。

**Tech Stack:** CF Workers + DO、Node daemon(@anthropic-ai/claude-agent-sdk)、iOS SwiftUI。

## Global Constraints

- agent bot = Directory `kind=bot` + `bots` 行(`backend=agent, owner_id, machine_id, dir`)。
- daemon 用共享 `DAEMON_TOKEN` 连 `/ws/daemon?machine=<id>`；hub URL = `mesh-api.jianshuo.dev`。
- daemon 事件以 bot 身份 ingest：`role=agent`，`author=<botUsername>`；`permission_request` body 加 `owner_id`。
- 审批门控：iOS 仅当 `Keychain.userId == owner_id` 渲染可点的允许/拒绝。
- 复用 Pager 代码：MachineDO、HubTask/HubToDaemon、permission_request/response、patch、琥珀卡、tool_card 渲染。
- hub 从 worktree 部署。

---

## Task B1: 协议——NewBotRequest + permission owner_id

**Files:** `packages/protocol/src/api.ts`（+`NewBotRequest`）、`packages/protocol/src/event.ts`（`PermissionRequestBody` 加可选 `owner_id`）；test `packages/protocol/test/*`。

**Produces:**
- `NewBotRequest = { name: string(3-20 归一化), machineId: string, dir: string }`
- `PermissionRequestBody` 增加 `owner_id: z.string().optional()`

- [ ] **Step 1: 写失败测试** — `NewBotRequest.parse({name:"mybot",machineId:"mch_x",dir:"/a"})` 通过；permission event 带 `owner_id` 能解析。
- [ ] **Step 2: 运行失败** — `cd packages/protocol && npx vitest run`。
- [ ] **Step 3: 实现** — api.ts：`export const NewBotRequest = z.object({ name: Username, machineId: z.string().min(1), dir: z.string().min(1) });`；event.ts：`PermissionRequestBody` 加 `owner_id: z.string().optional()`。
- [ ] **Step 4: 通过** + `npm run build`。
- [ ] **Step 5: Commit** — `feat(protocol): NewBotRequest + permission owner_id`。

---

## Task B2: 机器注册表 + MachineDO 上报改到它 + GET /api/machines

**Files:** Create `hub/src/machine-registry-do.ts`；Modify `hub/src/machine-do.ts`（`notifyStatus`→registry）、`hub/src/env.ts`（`MACHINEREG`）、`hub/wrangler.jsonc`（binding + migration v3）、`hub/src/index.ts`（`export`）；test `hub/test/machine-registry-do.test.ts`。

**Produces（MachineRegistryDO fetch 路由）:**
- `POST /upsert {id,name,dirs,online}` → 存/更新一台机器。
- `GET /machines` → `[{id,name,dirs,online}]`。

- [ ] **Step 1: 写失败测试** — upsert 一台在线机器 → `/machines` 含之，dirs 正确；下线后 online=false。
- [ ] **Step 2: 运行失败**。
- [ ] **Step 3: 实现** — MachineRegistryDO 建表 `machines(id PK,name,dirs TEXT,online INTEGER,updated_at)`；upsert/list。MachineDO `notifyStatus` 改为 `this.env.MACHINEREG.get(idFromName("registry")).fetch("/upsert", {id,name,dirs,online})`（删对 USER 单例的调用）。env 加 `MACHINEREG: DurableObjectNamespace`；wrangler 加 binding `MACHINEREG`→`MachineRegistryDO` + migration `{tag:"v3", new_sqlite_classes:["MachineRegistryDO"]}`；index.ts `export { ..., MachineRegistryDO }`。
- [ ] **Step 4: 通过**。
- [ ] **Step 5: Commit** — `feat(hub): 机器注册表 DO + MachineDO 上报改到它`。

---

## Task B3: DirectoryDO createBot(agent) + POST /api/bots

**Files:** Modify `hub/src/directory-do.ts`、`hub/src/index.ts`；test `hub/test/directory-do.test.ts` / `router.test.ts`。

**Produces:**
- DirectoryDO `POST /create-bot {name, ownerId, machineId, dir}` → 铸 `usr_<uuid>`(kind=bot) + bots 行(backend=agent,...)，返回 `{userId, username}`；保留名/重名 409。
- Worker `POST /api/bots {name,machineId,dir}`（session 鉴权）→ DirectoryDO create-bot（ownerId=me）；`GET /api/bots` 扩展为**内置 + 我创建的 agent bot**。

- [ ] **Step 1: 写失败测试** — 建 agent bot → `GET /api/bots` 含它（backend=agent）；`GET /bot?userId=` 返回 ownerId/machineId/dir；重名 409。
- [ ] **Step 2: 运行失败**。
- [ ] **Step 3: 实现** — DirectoryDO：`createBot` INSERT users(kind=bot)+bots(backend=agent,owner_id,machine_id,dir)；`listBots` 增参数或加 `/bots?owner=<id>` 返回内置+该 owner 的 agent bot。Worker：`POST /api/bots` 解析 `NewBotRequest`，调 create-bot；`GET /api/bots` 传 me.userId 拿内置+我的。
- [ ] **Step 4: 通过**。
- [ ] **Step 5: Commit** — `feat(hub): 建 agent bot（绑机器目录）+ /api/bots 含自建`。

---

## Task B4: ConversationDO agent 派发 + MachineDO 以 bot 身份回

**Files:** Modify `hub/src/conversation-do.ts`（dispatch agent 分支）、`hub/src/machine-do.ts`（deliver 带 bot 身份、event 转发盖 author+owner_id）；test `hub/test/machine-do.test.ts`（新建，假 daemon）。

**关键:**
- ConversationDO.dispatchBots：`d.backend==="agent"` → `env.MACHINE.get(idFromName(d.machineId)).fetch("/deliver", {kind:"task", conv, dir:d.dir, agent:"claude-code", botUserId:bot.userId, botUsername:bot.username, ownerId:d.ownerId, event})`。
- MachineDO：`/deliver` 收到 task 时存 `convBots[conv] = {botUsername, ownerId}`（storage 或内存 map），再转给 daemon。daemon 回的 `event`：ingest 前盖 `role=agent, body.author=botUsername`；若 `type==="permission_request"` 再盖 `body.owner_id=ownerId`。patch 原样转。

- [ ] **Step 1: 写失败测试** — 假 daemon 连 `/ws/daemon`；ConversationDO 里放一个 agent bot 成员（is_bot=1，Directory 里 backend=agent 指向该 machine）；人发消息 → daemon 收到 task；daemon 回一条 text → 会话里出现 role=agent、author=botUsername 的事件；回一条 permission_request → 事件 body 带 owner_id。
- [ ] **Step 2: 运行失败**。
- [ ] **Step 3: 实现** — 见上；`convBots` 用 `ctx.storage`。event 转发处按 botUsername/ownerId 盖字段。
- [ ] **Step 4: 通过**。
- [ ] **Step 5: Commit** — `feat(hub): agent bot 派发 daemon + 以 bot 身份回话/权限带 owner`。

---

## Task B5: Worker——/ws/daemon 回归 + /api/machines + 权限响应

**Files:** Modify `hub/src/index.ts`（+`MACHINE` 到 env 用；`/ws/daemon`、`GET /api/machines`、`POST /api/permission-response`）；test `hub/test/router.test.ts`。

**关键:**
- `/ws/daemon`：`if (path==="/ws/daemon"){ if(token!==env.DAEMON_TOKEN) 401; machineId=?machine; return env.MACHINE.get(idFromName(machineId)).fetch(/ws, req) }`（复用 Pager 原逻辑）。
- `GET /api/machines`（session 鉴权）→ MachineRegistryDO `/machines`。
- `POST /api/permission-response {conv,request_id,choice}`：查会话该 permission 的 bot → 其 ownerId；仅当 `me.userId===ownerId` 允许；转 `MACHINE.get(machineId).deliver({kind:"user_event", conv, event: permission_response})`。

- [ ] **Step 1: 写失败测试** — daemon token 错→401；`GET /api/machines` 列在线机器；非 owner 调 permission-response→403，owner→ok（假 daemon 收到 user_event）。
- [ ] **Step 2: 运行失败**。
- [ ] **Step 3: 实现** — 见上；env 已有 MACHINE。permission-response 需查 bot→owner：从会话 meta/成员 + Directory `/bot`。
- [ ] **Step 4: 通过** — `cd hub && npx vitest run` 全绿 + typecheck。
- [ ] **Step 5: Commit** — `feat(hub): /ws/daemon 回归 + /api/machines + 权限响应(owner 门控)`。

---

## Task B6: iOS——建 bot + 机器选择 + 权限卡门控

**Files:** Modify `ios/PagerApp/HubAPI.swift`(`machines()`,`createBot()`)、`Protocol.swift`(`MachineSummary` 复活 + permission `ownerId`)、`AppModel.swift`(`machines`,`refreshMachines`,`createBot`,`permissionRespond`)、`ContactsView.swift` 或新 `NewBotView.swift`(建 bot)、`ConversationView.swift`(权限卡 onPermission 接回)、`EventRowViews.swift`(权限卡按 owner 门控)。

- [ ] **Step 1: HubAPI/Protocol** — `MachineSummary{id,name,online,dirs}`；`machines()` GET `/api/machines`；`createBot(name,machineId,dir)` POST `/api/bots`；Event permission_request 解析 `owner_id`。
- [ ] **Step 2: AppModel** — `machines`+`refreshMachines`；`createBot`；`permissionRespond(conv,requestId,choice)` POST `/api/permission-response`。
- [ ] **Step 3: NewBotView** — 起名 + 选在线机器 + 选目录 → createBot → 出现在通讯录助手区（agent bot 用不同头像/标记）。
- [ ] **Step 4: 权限卡门控** — `EventRow` 传 `ownerId`；`PermissionRequestCard` 仅 `Keychain.userId==ownerId` 显示允许/拒绝，否则只读"等 XX 批准"；`ConversationView` 接回 `onPermission`→`model.permissionRespond`。
- [ ] **Step 5: 编译** BUILD SUCCEEDED。
- [ ] **Step 6: Commit** — `feat(ios): 建干活 bot + 机器选择 + 权限卡 owner 门控`。

---

## Task B7: daemon 接回 Mesh + 端到端

**Files:** daemon 配置（`~/.pager/daemon.json` hub→`mesh-api.jianshuo.dev`）；无仓库代码改动（daemon 协议兼容）。

- [ ] **Step 1: 重定向 daemon** — 改 `~/.pager/daemon.json` 的 hub URL 为 `wss://mesh-api.jianshuo.dev`；`bash daemon/deploy/install-launchd.sh` 重装/重启；确认连上（`GET /api/machines` 看到它在线）。
- [ ] **Step 2: 部署 hub** — 从 worktree `wrangler deploy`。
- [ ] **Step 3: 端到端** — iOS/脚本建一个 agent bot 绑本机+目录，私信它"看看这个目录有什么文件"，断言 daemon 跑起来、事件以 bot 身份流回、权限卡出现且仅 owner 可点。
- [ ] **Step 4: 推 main** → CI 出 iOS 新包。

---

## Self-Review（覆盖 spec B 期）
- §2 B 期（建 bot/绑机器/接回 daemon/权限）→ B3/B5/B7/B4 ✓；§8 审批 owner 门控 → B4(owner_id)+B5(权限响应)+B6(卡门控) ✓；§10 复用 daemon/MachineDO/权限/patch → B2/B4/B5 ✓；§9 iOS 建 bot/权限卡 → B6 ✓。
- 机器注册表是新增（Pager 用 UserDO 单例，Mesh 拆了 → 需独立 registry）。
- 待实现确认：MachineDO 的 `convBots` 用 ctx.storage 持久（DO 可能休眠）；permission-response 查 owner 走会话成员→Directory /bot。
