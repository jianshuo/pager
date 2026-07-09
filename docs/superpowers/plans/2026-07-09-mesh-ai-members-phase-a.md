# Mesh AI 成员 · A 期（Claude/ChatGPT 聊天 bot）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Claude、ChatGPT 作为内置 bot 成员接进 Mesh——人人可私信、可拉进群 @，hub 直连 Anthropic/OpenAI 流式回话。

**Architecture:** bot = Directory 账号（`kind=bot`）+ 后端描述符（`bots` 表）。消息 ingest 进 ConversationDO、扇给真人后，做「bot 派发」：被叫到的 bot（私信必叫 / 群里被@）→ hub 拉最近历史 → 调 LLM 流式 → 以 bot 身份 ingest 一条空 text 再用 patch 覆盖。全程复用现有成员/扇出/patch 机制。

**Tech Stack:** Cloudflare Workers + Durable Objects(SQLite)、zod(@pager/protocol)、Vitest + @cloudflare/vitest-pool-workers、iOS SwiftUI。

## Global Constraints

- 语言：注释/文案中文，标识符英文。
- bot 只响应**人类 text 消息**（`role=user`）；bot 自己的消息 `role=agent`，不触发派发（防死循环）。
- 内置 bot 固定 id：`usr_bot_claude`、`usr_bot_chatgpt`；`kind=bot`；无密码不可登录；保留用户名 `claude`/`chatgpt` 不许注册。
- 流式复用现有 `patch(conv,eventId,markdown)`；bot 消息 `role="agent"`, `body.author=<botUsername>`。
- 测试里 LLM 不真调：`env.BOT_MOCK` 存在时 responder 产出固定回复。真部署用 `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`。
- 上下文：拉本会话最近 ≤30 条事件组装历史。
- hub 从 worktree 部署。

---

## Task A1: 协议——bot 标记 + BotSummary

**Files:**
- Modify: `packages/protocol/src/api.ts`
- Test: `packages/protocol/test/api.test.ts`

**Interfaces (Produces):**
- `BotBackend = z.enum(["claude","chatgpt","agent"])`
- `BotSummary = { userId, username, backend, displayName }`
- `UserSummary` 增加 `kind: "human"|"bot"`（默认 "human"）

- [ ] **Step 1: 写失败测试** — 在 `api.test.ts` 加：
```ts
import { BotSummary, UserSummary } from "../src/index.js";
it("BotSummary 解析", () => {
  const b = BotSummary.parse({ userId:"usr_bot_claude", username:"claude", backend:"claude", displayName:"Claude" });
  expect(b.backend).toBe("claude");
});
it("UserSummary kind 默认 human", () => {
  expect(UserSummary.parse({ userId:"usr_1", username:"a" }).kind).toBe("human");
});
```
- [ ] **Step 2: 运行确认失败** — `cd packages/protocol && npx vitest run test/api.test.ts` 期望 FAIL。
- [ ] **Step 3: 实现** — 在 `api.ts`：
```ts
export const BotBackend = z.enum(["claude", "chatgpt", "agent"]);
export type BotBackend = z.infer<typeof BotBackend>;
export const BotSummary = z.object({
  userId: z.string().startsWith("usr_"),
  username: z.string(),
  backend: BotBackend,
  displayName: z.string(),
});
export type BotSummary = z.infer<typeof BotSummary>;
```
并把 `UserSummary` 改为：
```ts
export const UserSummary = z.object({
  userId: z.string().startsWith("usr_"),
  username: z.string(),
  kind: z.enum(["human", "bot"]).default("human"),
});
```
- [ ] **Step 4: 运行确认通过** — 同命令 PASS。
- [ ] **Step 5: 构建 + 提交** — `npm run build`；`git add packages/protocol && git commit -m "feat(protocol): bot 标记 + BotSummary"`。

---

## Task A2: DirectoryDO——kind + bots 表 + 预置 Claude/ChatGPT

**Files:**
- Modify: `hub/src/directory-do.ts`
- Test: `hub/test/directory-do.test.ts`

**Interfaces (Produces) — DirectoryDO fetch 路由新增：**
- 构造函数：`users` 加列 `kind`；建 `bots` 表；`ensureBuiltinBots()` 幂等铸 Claude/ChatGPT。
- `POST /register`：拒绝保留名 `claude`/`chatgpt`。
- `POST /lookup` 返回增加 `kind`。
- `GET /bot?userId=<id>` → `{ userId, username, backend, model, ownerId, machineId, dir }` 或 null。
- `GET /bots` → 内置 bot 列表 `BotSummary[]`（A 期只有 claude/chatgpt）。

- [ ] **Step 1: 写失败测试** —
```ts
it("预置 Claude/ChatGPT + /bots 列出", async () => {
  const r = await dir().fetch("https://do/bots");
  const bots = await r.json<any[]>();
  expect(bots.map(b=>b.username).sort()).toEqual(["chatgpt","claude"]);
  expect(bots.find(b=>b.username==="claude").userId).toBe("usr_bot_claude");
});
it("保留名不许注册", async () => {
  const r = await post("/register", { username:"claude", password:"hunter2" });
  expect(r.status).toBe(409);
});
it("lookup 返回 kind=bot", async () => {
  const who = await (await post("/lookup", { username:"claude" })).json<any>();
  expect(who.kind).toBe("bot");
});
```
- [ ] **Step 2: 运行确认失败** — `cd hub && npx vitest run test/directory-do.test.ts`。
- [ ] **Step 3: 实现** — 构造函数末尾：
```ts
try { this.sql.exec("ALTER TABLE users ADD COLUMN kind TEXT NOT NULL DEFAULT 'human'"); } catch {}
this.sql.exec(`CREATE TABLE IF NOT EXISTS bots (
  user_id TEXT PRIMARY KEY, backend TEXT NOT NULL, model TEXT NOT NULL DEFAULT '',
  owner_id TEXT NOT NULL DEFAULT '', machine_id TEXT NOT NULL DEFAULT '', dir TEXT NOT NULL DEFAULT '')`);
this.ensureBuiltinBots();
```
新增方法：
```ts
private ensureBuiltinBots(): void {
  const builtins = [
    { id: "usr_bot_claude", name: "claude", display: "Claude", backend: "claude", model: "claude-opus-4-8" },
    { id: "usr_bot_chatgpt", name: "chatgpt", display: "ChatGPT", backend: "chatgpt", model: "gpt-5" },
  ];
  const now = nowSec();
  for (const b of builtins) {
    this.sql.exec(
      "INSERT OR IGNORE INTO users (user_id, username, pw_hash, created_at, kind) VALUES (?, ?, '', ?, 'bot')",
      b.id, b.name, now);
    this.sql.exec(
      "INSERT OR IGNORE INTO bots (user_id, backend, model) VALUES (?, ?, ?)", b.id, b.backend, b.model);
  }
}
```
`register`：查重前加 `if (["claude","chatgpt"].includes(username)) return Response.json({error:"用户名被保留"},{status:409});`
`lookup`：`SELECT user_id, username, kind FROM users WHERE username = ?`，返回带 `kind`。
新路由：
```ts
case "GET /bots": {
  const rows = [...this.sql.exec(
    "SELECT u.user_id, u.username, b.backend FROM bots b JOIN users u ON u.user_id=b.user_id WHERE b.backend IN ('claude','chatgpt')")];
  const disp: Record<string,string> = { claude:"Claude", chatgpt:"ChatGPT" };
  return Response.json(rows.map(r => ({ userId:r.user_id, username:r.username, backend:r.backend, displayName: disp[r.backend as string] ?? r.username })));
}
```
`GET /bot`（`url.searchParams`）：
```ts
if (url.pathname === "/bot") {
  const id = url.searchParams.get("userId") ?? "";
  const r = [...this.sql.exec("SELECT user_id, backend, model, owner_id, machine_id, dir FROM bots WHERE user_id=?", id)][0];
  return r ? Response.json({ userId:r.user_id, backend:r.backend, model:r.model, ownerId:r.owner_id, machineId:r.machine_id, dir:r.dir }) : Response.json(null);
}
```
（`GET` 带 query 的路由用 `if (url.pathname===...)` 放在 `switch` 前。）
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: 提交** — `git commit -m "feat(hub): DirectoryDO bot kind + bots 表 + 预置 Claude/ChatGPT"`。

---

## Task A3: responder——Anthropic/OpenAI 流式 + mock

**Files:**
- Create: `hub/src/responder.ts`
- Test: `hub/test/responder.test.ts`

**Interfaces (Produces):**
- `type ChatMsg = { role: "user"|"assistant"; content: string }`
- `async function* streamBotReply(env: Env, backend: "claude"|"chatgpt", model: string, system: string, messages: ChatMsg[]): AsyncGenerator<string>` — yield 增量文本。`env.BOT_MOCK` 存在时产出固定 mock。

- [ ] **Step 1: 写失败测试** —
```ts
import { streamBotReply } from "../src/responder.js";
it("BOT_MOCK 下产出固定回复", async () => {
  const env: any = { BOT_MOCK: "1" };
  let out = "";
  for await (const d of streamBotReply(env, "claude", "m", "sys", [{role:"user",content:"你好"}])) out += d;
  expect(out).toContain("你好");
  expect(out.length).toBeGreaterThan(0);
});
```
- [ ] **Step 2: 运行确认失败** — `npx vitest run test/responder.test.ts`。
- [ ] **Step 3: 实现** —
```ts
import type { Env } from "./env.js";
export type ChatMsg = { role: "user" | "assistant"; content: string };

export async function* streamBotReply(env: Env, backend: "claude"|"chatgpt", model: string, system: string, messages: ChatMsg[]): AsyncGenerator<string> {
  if (env.BOT_MOCK) {
    const last = messages.filter(m=>m.role==="user").slice(-1)[0]?.content ?? "";
    for (const part of ["（mock）收到：", last]) { yield part; }
    return;
  }
  if (backend === "claude") { yield* streamAnthropic(env, model, system, messages); }
  else { yield* streamOpenAI(env, model, system, messages); }
}

async function* streamAnthropic(env: Env, model: string, system: string, messages: ChatMsg[]): AsyncGenerator<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type":"application/json", "x-api-key": env.ANTHROPIC_API_KEY ?? "", "anthropic-version":"2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 1024, system, stream: true,
      messages: messages.map(m=>({ role:m.role, content:m.content })) }),
  });
  yield* sseText(res, (j)=> j.type==="content_block_delta" ? (j.delta?.text ?? "") : "");
}

async function* streamOpenAI(env: Env, model: string, system: string, messages: ChatMsg[]): AsyncGenerator<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type":"application/json", authorization:`Bearer ${env.OPENAI_API_KEY ?? ""}` },
    body: JSON.stringify({ model, stream: true,
      messages: [{ role:"system", content: system }, ...messages] }),
  });
  yield* sseText(res, (j)=> j.choices?.[0]?.delta?.content ?? "");
}

// 通用 SSE 解析：逐行取 data:，JSON.parse 后用 pick 抽增量
async function* sseText(res: Response, pick: (j: any)=>string): AsyncGenerator<string> {
  if (!res.body) return;
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim(); if (data === "[DONE]") return;
      try { const t = pick(JSON.parse(data)); if (t) yield t; } catch {}
    }
  }
}
```
`env.ts` 加：`BOT_MOCK?: string; ANTHROPIC_API_KEY?: string; OPENAI_API_KEY?: string;`
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: 提交** — `git commit -m "feat(hub): LLM 流式 responder（Anthropic/OpenAI + mock）"`。

---

## Task A4: ConversationDO——成员 is_bot + bot 派发 + hubRespond

**Files:**
- Modify: `hub/src/conversation-do.ts`
- Test: `hub/test/conversation-do.test.ts`

**Interfaces:**
- Consumes: `streamBotReply`（A3）、DirectoryDO `GET /bot?userId=`（A2）。
- `members` 加列 `is_bot INTEGER NOT NULL DEFAULT 0`；`init`/`addMember` 接受 `isBot`。
- ingest 末尾：人类 text → `dispatchBots(event)`。

- [ ] **Step 1: 写失败测试** —（用 `env.BOT_MOCK` 由 vitest 配置注入，见 A7 前置）
```ts
it("私信 bot：人类发消息触发 bot 以 agent 身份回话", async () => {
  const [A, c] = ["usr_h1", "dm_usr_bot_claude_usr_h1"];
  await post(user(A), "/index-conv", { conv:c, kind:"direct" });
  await post(user("usr_bot_claude"), "/index-conv", { conv:c, kind:"direct" });
  await post(conv(c), "/init", { kind:"direct", createdBy:A, members:[
    { userId:A, username:"h1", isBot:false }, { userId:"usr_bot_claude", username:"claude", isBot:true }]});
  await post(conv(c), "/ingest", { event: textDraft("evt_h1", c, "你好"), senderUsername:"h1", senderUserId:A });
  // 轮询会话事件，出现 role=agent 的 bot 回复
  const ev = await until(async () => {
    const list = await (await conv(c).fetch("https://do/events?after=0")).json<any[]>();
    return list.find(e => e.role==="agent" && e.body.author==="claude" && (e.body.markdown||"").includes("你好"));
  });
  expect(ev).toBeTruthy();
});
it("群里不@bot 不触发；@了才触发", async () => {
  const [A, c] = ["usr_h2", "cnv_g_bot"];
  for (const [u,n,bot] of [[A,"h2",false],["usr_bot_claude","claude",true]] as const)
    await post(user(u), "/index-conv", { conv:c, kind:"group", title:"g" });
  await post(conv(c), "/init", { kind:"group", title:"g", createdBy:A, members:[
    { userId:A, username:"h2", isBot:false }, { userId:"usr_bot_claude", username:"claude", isBot:true }]});
  await post(conv(c), "/ingest", { event: textDraft("evt_n", c, "大家好"), senderUsername:"h2", senderUserId:A });
  await new Promise(r=>setTimeout(r,300));
  let list = await (await conv(c).fetch("https://do/events?after=0")).json<any[]>();
  expect(list.some(e=>e.role==="agent")).toBe(false);
  await post(conv(c), "/ingest", { event: textDraft("evt_m", c, "@claude 在吗"), senderUsername:"h2", senderUserId:A });
  const hit = await until(async () => (await (await conv(c).fetch("https://do/events?after=0")).json<any[]>()).find(e=>e.role==="agent"));
  expect(hit).toBeTruthy();
});
```
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现** —
  - `members` CREATE 加 `is_bot INTEGER NOT NULL DEFAULT 0`；`init` 与 `addMember` 的 INSERT 增加 `is_bot`（`m.isBot ? 1 : 0`）。
  - `ingest` 在 `return Response.json(event)` 前加：`if (event.type==="text" && event.role==="user") this.ctx.waitUntil(this.dispatchBots(event));`
  - 新增：
```ts
private botMembers(): { userId: string; username: string }[] {
  return [...this.sql.exec("SELECT user_id, username FROM members WHERE is_bot=1")]
    .map(r => ({ userId: r.user_id as string, username: r.username as string }));
}
private async dispatchBots(event: EventLoose): Promise<void> {
  const meta = await this.ctx.storage.get<ConvMeta>("meta");
  const text = (event.body as any)?.markdown ?? "";
  const bots = this.botMembers();
  const addressed = meta?.kind === "direct"
    ? bots  // 私信里唯一的 bot
    : bots.filter(b => new RegExp(`@${b.username}\\b`, "i").test(text)); // 群：被 @
  for (const bot of addressed) {
    const d = await (await this.dir().fetch(`https://do/bot?userId=${bot.userId}`)).json<any>();
    if (!d || (d.backend !== "claude" && d.backend !== "chatgpt")) continue; // A 期只处理聊天 bot
    await this.hubRespond(bot, d);
  }
}
private async hubRespond(bot: { userId: string; username: string }, d: any): Promise<void> {
  // 1) 先 ingest 一条空 text（拿 seq/id）
  const draft = { id: `evt_${crypto.randomUUID()}`, conv: this.convId(), ts: nowSec(),
    role: "agent", agent: "claude-code", type: "text", body: { markdown: "", author: bot.username } };
  const sealedRes = await this.ingest({ event: draft });
  const sealed = await sealedRes.json<any>();
  // 2) 拉历史组装 messages
  const history = [...this.sql.exec("SELECT json FROM events WHERE seq >= 1 ORDER BY seq DESC LIMIT 31")]
    .map(r => JSON.parse(r.json as string)).reverse()
    .filter(e => e.type === "text" && e.id !== sealed.id);
  const messages = history.map((e: any) => ({
    role: (e.role === "agent" && e.body.author === bot.username) ? "assistant" : "user",
    content: e.role === "agent" ? (e.body.markdown ?? "")
      : `${e.body.author ?? "用户"}: ${e.body.markdown ?? ""}`,
  }));
  const system = `你是 ${bot.username}，Mesh 里的一个 AI 成员，正在和用户对话。简洁、直接、有帮助地回复。`;
  // 3) 流式 → patch
  let acc = "";
  try {
    for await (const delta of streamBotReply(this.env, d.backend, d.model || "", system, messages as any)) {
      acc += delta;
      await this.patch({ conv: this.convId(), eventId: sealed.id, markdown: acc });
    }
    if (!acc) await this.patch({ conv: this.convId(), eventId: sealed.id, markdown: "（无回复）" });
  } catch (e) {
    await this.patch({ conv: this.convId(), eventId: sealed.id, markdown: `⚠️ ${bot.username} 出错了，稍后再试。` });
  }
}
private convId(): string {
  return (this.ctx.id as any).name ?? ""; // init 时会话 id；用 events 里的 conv 更稳
}
private dir(): DurableObjectStub { return this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName("directory")); }
```
  - `convId()` 不可靠时改为从任一 event 读 `conv`；实现时用 `event.conv`（dispatchBots 已有 event）传进 hubRespond 更稳——把 `conv` 作参数传递。
  - import：`import { streamBotReply } from "./responder.js";`
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: 提交** — `git commit -m "feat(hub): ConversationDO bot 派发 + hubRespond 流式"`。

---

## Task A5: Worker 路由——/api/bots + 建会话带 isBot

**Files:**
- Modify: `hub/src/index.ts`
- Test: `hub/test/router.test.ts`

**Interfaces:**
- `GET /api/bots` → 内置 `BotSummary[]`（转发 DirectoryDO `/bots`）。
- `directConversation` / `newGroup` / `addMember` 组装 members 时，对每个 userId 查 kind，带 `isBot`。

- [ ] **Step 1: 写失败测试** —
```ts
it("GET /api/bots 列出 Claude/ChatGPT", async () => {
  const a = await register("r_bots_a");
  const bots = await (await api("/api/bots", { token:a.token })).json<any[]>();
  expect(bots.map((b:any)=>b.username).sort()).toEqual(["chatgpt","claude"]);
});
it("和 Claude 建直连→发消息→收到 mock 回复", async () => {
  const a = await register("r_bots_b");
  const dc = await (await api("/api/conversations/direct", { token:a.token, body:{ userId:"usr_bot_claude" }})).json<any>();
  const w = await clientWs(a.token); w.ws.send(JSON.stringify({ kind:"subscribe", conv:dc.id, afterSeq:0 }));
  w.ws.send(JSON.stringify({ kind:"send", conv:dc.id, event:{ id:"evt_b1", conv:dc.id, ts:1, role:"user", agent:"claude-code", type:"text", body:{ markdown:"讲个笑话", author:"r_bots_b" }}}));
  const bot = await until(async ()=> w.got.find((g:any)=> g.kind==="event" && g.event.role==="agent") || w.got.find((g:any)=>g.kind==="patch"));
  expect(bot).toBeTruthy(); w.ws.close();
});
```
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现** —
  - 加路由（在鉴权后）：`if (path==="/api/bots" && req.method==="GET") return directory(env).fetch("https://do/bots");`
  - 加 helper：
```ts
async function memberWithBotFlag(env: Env, userId: string, username: string): Promise<{userId:string;username:string;isBot:boolean}> {
  const who = await (await directory(env).fetch("https://do/lookup", { method:"POST", body: JSON.stringify({ username }) })).json<any>();
  return { userId, username, isBot: who?.kind === "bot" };
}
```
  - `directConversation`：peer 的 member 用 `isBot`（查 lookup 的 kind）。both members 传 `isBot`。
  - `newGroup`/`addMember`：`resolveNames` 已有 username；对每个成员补 `isBot`（查 kind，或让 DirectoryDO `/names` 返回 kind 一起给 → 优化：改 `/names` 返回 `{userId,username,kind}`）。**实现时改 `/names` 附带 kind**，member.isBot = kind==="bot"。
  - `ingestSystem`、init/members 调用处传 `isBot`。
- [ ] **Step 4: 运行确认通过** — `npx vitest run`（全 hub 套件）。
- [ ] **Step 5: 提交** — `git commit -m "feat(hub): /api/bots + 建会话带 isBot 成员"`。

---

## Task A6: iOS——通讯录助手区 + @成员选择

**Files:**
- Modify: `ios/PagerApp/HubAPI.swift`（`bots() -> [BotSummary]`）
- Modify: `ios/PagerApp/Protocol.swift`（`BotSummary`）
- Modify: `ios/PagerApp/AppModel.swift`（`bots` 属性 + `refreshBots()`）
- Modify: `ios/PagerApp/ContactsView.swift`（顶部"助手"区）
- Modify: `ios/PagerApp/ConversationView.swift`（群里 `@` 弹成员选择插入 `@username`）
- Test: 编译 + 现有测试

- [ ] **Step 1: Protocol + HubAPI** — `BotSummary: Decodable { userId, username, backend, displayName }`；`HubAPI.bots()` GET `/api/bots`。
- [ ] **Step 2: AppModel** — `private(set) var bots: [BotSummary]`；`refreshBots() async`（`try? await api.bots()`）。ContactsView `.task` 调它。
- [ ] **Step 3: ContactsView** — 顶部 Section「助手」列 `model.bots`（Claude/ChatGPT，AIAvatar），点击 `model.openDirect(userId:)` → onStartChat；下面才是真人好友。
- [ ] **Step 4: ConversationView @选择** — 群会话里输入 `@` 时弹出成员列表（含 bot），选中插入 `@<username> `。最小实现：composer 上方一个可选 mention bar，检测 draft 尾部 `@` 触发。
- [ ] **Step 5: 编译** — `cd ios && xcodegen generate && xcodebuild -scheme Pager -destination 'generic/platform=iOS Simulator' build` 期望 BUILD SUCCEEDED。
- [ ] **Step 6: 提交** — `git commit -m "feat(ios): 通讯录助手区(Claude/ChatGPT) + 群@成员选择"`。

---

## Task A7: 测试配线 + 端到端冒烟 + 部署

**Files:**
- Modify: `hub/vitest.config.ts`（miniflare bindings 加 `BOT_MOCK: "1"`）
- Modify: `hub/scripts/smoke.mjs`（加 bot DM 冒烟，可选）
- Test: 全套

- [ ] **Step 1: vitest 注入 BOT_MOCK** — `miniflare.bindings` 加 `BOT_MOCK: "1"`，让 DO 测试里 responder 走 mock。
- [ ] **Step 2: 跑全套** — `cd hub && npx vitest run` 全绿；`cd packages/protocol && npx vitest run` 全绿。
- [ ] **Step 3: 配密钥 + 部署** — `cd hub && wrangler secret put ANTHROPIC_API_KEY`、`wrangler secret put OPENAI_API_KEY`（从 worktree 部署）；`wrangler deploy`。
- [ ] **Step 4: 线上冒烟** — 注册一个临时账号，`POST /api/conversations/direct {userId:"usr_bot_claude"}`，WS 发一条真实消息，断言收到**非 mock** 的流式回复（patch）。清理临时账号。
- [ ] **Step 5: 提交 + 推 main** — `git commit -m "test(hub): bot mock 配线 + 冒烟"`；push 触发 iOS CI 出带助手区的新包。

---

## Self-Review（覆盖检查）
- spec §3 抽象（账号+描述符）→ A1/A2 ✓；§4 数据模型 → A2(bots) / A4(is_bot) ✓；§5 唤起（私信必回/群@/只回真人）→ A4 dispatchBots ✓；§6 路由 hubRespond → A4 ✓；§7 流式 patch → A4 ✓；§9 iOS 通讯录/气泡/@ → A6 ✓（AI 气泡 role=agent 已存在，复用）；§11 密钥 → A7 ✓；§12 测试 → 各 task + A7 ✓。
- B 期（agent bot / daemon / 权限 owner 门控）不在本计划——单独出 `2026-XX-XX-mesh-ai-members-phase-b.md`。
- 待实现时确认：`hubRespond` 用 `event.conv` 显式传 convId（勿依赖 ctx.id.name）；`/names` 附带 kind 以省一次查询。
