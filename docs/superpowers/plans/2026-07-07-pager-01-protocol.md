# Pager 01 — 协议包（@pager/protocol）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建好 pager monorepo 骨架，并交付 daemon 与 hub 共享的协议包 `@pager/protocol`——Event 信封、六种 body、WS wire 消息、REST DTO、id 生成器，全部 zod schema + 测试。

**Architecture:** 瘦中枢 + 胖 daemon（spec `docs/superpowers/specs/2026-07-07-pager-design.md`）。本计划只做「宪法」层：所有组件之间传输的数据结构，双端用同一个 npm workspace 包校验。后续计划：02-hub（CF Worker+DO）、03-daemon、04-ios，依次在前一份落地后编写。

**Tech Stack:** TypeScript 5.5+（strict, NodeNext ESM）、zod ^3.23、vitest ^2、npm workspaces、Node ≥ 20。

## Global Constraints

- Node ≥ 20（daemon 与本包共用；`crypto.randomUUID` 全局可用）。
- TypeScript `strict: true`，模块格式 NodeNext ESM——**源码内相对导入必须带 `.js` 后缀**（如 `from "./event.js"`）。
- zod 固定 v3 系（`^3.23.0`），不用 v4。
- 所有包 `private: true`，不发 npm。
- monorepo 根 workspaces 本阶段只含 `packages/*`；`daemon`、`hub`、`ios` 由后续计划各自加入。
- 事件 id 前缀约定：event `evt_`、conversation `cnv_`、machine `mch_`。
- `seq` 由 ConversationDO 分配：daemon/client 上行的事件一律用 `EventDraft`（无 seq），落库/下行一律用 `Event`（有 seq）。
- commit 信息用 conventional commits（feat/test/chore/docs）。

---

### Task 1: Monorepo 脚手架 + Event / EventDraft schema

**Files:**
- Create: `package.json`（根）
- Create: `.gitignore`
- Create: `tsconfig.base.json`
- Create: `packages/protocol/package.json`
- Create: `packages/protocol/tsconfig.json`
- Create: `packages/protocol/src/event.ts`
- Test: `packages/protocol/test/event.test.ts`

**Interfaces:**
- Consumes: 无（首个任务）。
- Produces: `Event`（zod discriminated union，type ∈ text | tool_card | permission_request | permission_response | status | error，字段 id/conv/seq/ts/role/agent/type/body）、`EventDraft`（同 union 去掉 seq）、`Role`、`StatusState`、`PermissionChoice`、`TextBody`、`ToolCardBody`、`PermissionRequestBody`、`PermissionResponseBody`、`StatusBody`、`ErrorBody`。同名 TS 类型经 `z.infer` 一并导出。Task 2/3 从 `./event.js` 导入。

- [ ] **Step 1: 写脚手架文件**

`package.json`（根）：

```json
{
  "name": "pager",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*"],
  "scripts": {
    "test": "npm run test --workspaces --if-present",
    "build": "npm run build --workspaces --if-present"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vitest": "^2.1.0"
  }
}
```

`.gitignore`：

```
node_modules/
dist/
.DS_Store
.claude/worktrees/
```

`tsconfig.base.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "declaration": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

`packages/protocol/package.json`：

```json
{
  "name": "@pager/protocol",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "zod": "^3.23.0"
  }
}
```

`packages/protocol/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src"]
}
```

- [ ] **Step 2: 安装依赖**

Run: `npm install`（在仓库根）
Expected: 生成 `package-lock.json`，`node_modules/zod` 存在，无 error。

- [ ] **Step 3: 写失败测试**

`packages/protocol/test/event.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { Event, EventDraft } from "../src/event.js";

const validText = {
  id: "evt_1",
  conv: "cnv_1",
  seq: 1,
  ts: 1751780000,
  role: "agent",
  agent: "claude-code",
  type: "text",
  body: { markdown: "hello **world**" },
};

describe("Event", () => {
  it("解析合法 text 事件", () => {
    expect(Event.parse(validText)).toEqual(validText);
  });

  it("agent 字段缺省为 claude-code", () => {
    const { agent, ...noAgent } = validText;
    expect(Event.parse(noAgent).agent).toBe("claude-code");
  });

  it("拒绝未知 type", () => {
    expect(() => Event.parse({ ...validText, type: "nope" })).toThrow();
  });

  it("拒绝 type 与 body 不匹配（text 配 tool_card body）", () => {
    expect(() =>
      Event.parse({ ...validText, body: { tool: "Bash", title: "x" } })
    ).toThrow();
  });

  it("拒绝错误 id 前缀", () => {
    expect(() => Event.parse({ ...validText, id: "x_1" })).toThrow();
  });

  it("解析 permission_request 事件", () => {
    const evt = {
      ...validText,
      type: "permission_request",
      role: "agent",
      body: {
        request_id: "req_1",
        tool: "Bash",
        description: "运行 rm -rf build/",
        options: ["allow", "deny", "allow_always"],
      },
    };
    expect(Event.parse(evt).type).toBe("permission_request");
  });

  it("拒绝 permission_request 的非法 choice 选项", () => {
    const evt = {
      ...validText,
      type: "permission_request",
      body: { request_id: "r", tool: "Bash", description: "d", options: ["maybe"] },
    };
    expect(() => Event.parse(evt)).toThrow();
  });

  it("解析 status 事件并拒绝非法 state", () => {
    const ok = { ...validText, type: "status", body: { state: "running" } };
    expect(Event.parse(ok).body).toEqual({ state: "running" });
    expect(() =>
      Event.parse({ ...validText, type: "status", body: { state: "paused" } })
    ).toThrow();
  });
});

describe("EventDraft", () => {
  it("无 seq 可解析", () => {
    const { seq, ...draft } = validText;
    expect(EventDraft.parse(draft)).toEqual(draft);
  });

  it("Event 缺 seq 应报错（与 Draft 的区别）", () => {
    const { seq, ...draft } = validText;
    expect(() => Event.parse(draft)).toThrow();
  });
});
```

- [ ] **Step 4: 跑测试确认失败**

Run: `npm test -w packages/protocol`
Expected: FAIL，报错含 `Failed to resolve import "../src/event.js"`（模块不存在）。

- [ ] **Step 5: 实现 event.ts**

`packages/protocol/src/event.ts`：

```ts
import { z } from "zod";

export const Role = z.enum(["user", "agent", "system"]);
export type Role = z.infer<typeof Role>;

export const StatusState = z.enum([
  "thinking",
  "running",
  "waiting_input",
  "done",
  "failed",
]);
export type StatusState = z.infer<typeof StatusState>;

export const PermissionChoice = z.enum(["allow", "deny", "allow_always"]);
export type PermissionChoice = z.infer<typeof PermissionChoice>;

export const TextBody = z.object({ markdown: z.string() });
export type TextBody = z.infer<typeof TextBody>;

export const ToolCardBody = z.object({
  tool: z.string(),
  title: z.string(),
  summary: z.string().default(""),
  detail: z.string().default(""),
  diff: z.string().optional(),
});
export type ToolCardBody = z.infer<typeof ToolCardBody>;

export const PermissionRequestBody = z.object({
  request_id: z.string(),
  tool: z.string(),
  description: z.string(),
  options: z.array(PermissionChoice).min(1),
});
export type PermissionRequestBody = z.infer<typeof PermissionRequestBody>;

export const PermissionResponseBody = z.object({
  request_id: z.string(),
  choice: PermissionChoice,
});
export type PermissionResponseBody = z.infer<typeof PermissionResponseBody>;

export const StatusBody = z.object({
  state: StatusState,
  note: z.string().optional(),
});
export type StatusBody = z.infer<typeof StatusBody>;

export const ErrorBody = z.object({
  message: z.string(),
  recoverable: z.boolean(),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

// seq 由 ConversationDO 分配：上行用 EventDraft（无 seq），落库/下行用 Event
const base = {
  id: z.string().startsWith("evt_"),
  conv: z.string().startsWith("cnv_"),
  seq: z.number().int().nonnegative(),
  ts: z.number().int().positive(),
  role: Role,
  agent: z.string().default("claude-code"),
};

const { seq: _seq, ...draftBase } = base;

const variant = <T extends string, B extends z.ZodTypeAny>(type: T, body: B) =>
  z.object({ ...base, type: z.literal(type), body });

const draftVariant = <T extends string, B extends z.ZodTypeAny>(type: T, body: B) =>
  z.object({ ...draftBase, type: z.literal(type), body });

export const Event = z.discriminatedUnion("type", [
  variant("text", TextBody),
  variant("tool_card", ToolCardBody),
  variant("permission_request", PermissionRequestBody),
  variant("permission_response", PermissionResponseBody),
  variant("status", StatusBody),
  variant("error", ErrorBody),
]);
export type Event = z.infer<typeof Event>;

export const EventDraft = z.discriminatedUnion("type", [
  draftVariant("text", TextBody),
  draftVariant("tool_card", ToolCardBody),
  draftVariant("permission_request", PermissionRequestBody),
  draftVariant("permission_response", PermissionResponseBody),
  draftVariant("status", StatusBody),
  draftVariant("error", ErrorBody),
]);
export type EventDraft = z.infer<typeof EventDraft>;
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npm test -w packages/protocol`
Expected: PASS，11 个用例全绿。

- [ ] **Step 7: 确认 tsc 能编译**

Run: `npm run build -w packages/protocol`
Expected: 生成 `packages/protocol/dist/event.js` 与 `.d.ts`，无编译错误。

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json .gitignore tsconfig.base.json packages/protocol
git commit -m "feat(protocol): monorepo 脚手架 + Event/EventDraft schema"
```

---

### Task 2: WS wire 协议（四个方向的消息 union）

**Files:**
- Create: `packages/protocol/src/wire.ts`
- Test: `packages/protocol/test/wire.test.ts`

**Interfaces:**
- Consumes: `Event`、`EventDraft`（Task 1，`./event.js`）。
- Produces:
  - `DaemonToHub = DaemonHello | DaemonEvent | DaemonPatch | DaemonSession`（discriminator `kind`: "hello" | "event" | "patch" | "session"）
  - `HubToDaemon = HubTask | HubUserEvent | HubInterrupt`（`kind`: "task" | "user_event" | "interrupt"）
  - `ClientToHub = ClientSubscribe | ClientSend`（`kind`: "subscribe" | "send"）
  - `HubToClient = HubEvent | HubPatch`（`kind`: "event" | "patch"）
  - `MachineInfo = { id: "mch_..." , name: string }`
  - 各成员 schema 与同名 TS 类型均导出。02-hub 与 03-daemon 计划直接消费。

- [ ] **Step 1: 写失败测试**

`packages/protocol/test/wire.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import {
  DaemonToHub,
  HubToDaemon,
  ClientToHub,
  HubToClient,
} from "../src/wire.js";

const draftText = {
  id: "evt_1",
  conv: "cnv_1",
  ts: 1751780000,
  role: "agent",
  agent: "claude-code",
  type: "text",
  body: { markdown: "hi" },
};

const sealedText = { ...draftText, seq: 7, role: "user" };

describe("DaemonToHub", () => {
  it("解析 hello", () => {
    const msg = {
      kind: "hello",
      machine: { id: "mch_mac", name: "建硕的 Mac" },
      dirs: ["/Users/jianshuo/code/pager"],
      maxConcurrent: 4,
    };
    expect(DaemonToHub.parse(msg).kind).toBe("hello");
  });

  it("解析 event（携带 EventDraft，无 seq）", () => {
    expect(DaemonToHub.parse({ kind: "event", event: draftText }).kind).toBe("event");
  });

  it("拒绝 event 携带已盖 seq 的事件之外的脏数据", () => {
    expect(() =>
      DaemonToHub.parse({ kind: "event", event: { ...draftText, type: "nope" } })
    ).toThrow();
  });

  it("解析 patch 与 session", () => {
    expect(
      DaemonToHub.parse({ kind: "patch", conv: "cnv_1", eventId: "evt_1", markdown: "hi!" }).kind
    ).toBe("patch");
    expect(
      DaemonToHub.parse({ kind: "session", conv: "cnv_1", agentSessionId: "s-123" }).kind
    ).toBe("session");
  });
});

describe("HubToDaemon", () => {
  it("解析 task（event 必须已盖 seq）", () => {
    const msg = {
      kind: "task",
      conv: "cnv_1",
      dir: "/Users/jianshuo/code/pager",
      agent: "claude-code",
      event: sealedText,
    };
    expect(HubToDaemon.parse(msg).kind).toBe("task");
  });

  it("task 的 event 缺 seq 应报错", () => {
    const msg = {
      kind: "task",
      conv: "cnv_1",
      dir: "/x",
      agent: "claude-code",
      event: draftText,
    };
    expect(() => HubToDaemon.parse(msg)).toThrow();
  });

  it("解析 user_event 与 interrupt", () => {
    expect(
      HubToDaemon.parse({ kind: "user_event", conv: "cnv_1", event: sealedText }).kind
    ).toBe("user_event");
    expect(HubToDaemon.parse({ kind: "interrupt", conv: "cnv_1" }).kind).toBe("interrupt");
  });
});

describe("ClientToHub", () => {
  it("解析 subscribe（afterSeq 增量补齐）", () => {
    expect(
      ClientToHub.parse({ kind: "subscribe", conv: "cnv_1", afterSeq: 0 }).kind
    ).toBe("subscribe");
  });

  it("解析 send（EventDraft）", () => {
    expect(
      ClientToHub.parse({ kind: "send", conv: "cnv_1", event: { ...draftText, role: "user" } }).kind
    ).toBe("send");
  });
});

describe("HubToClient", () => {
  it("解析 event 与 patch", () => {
    expect(HubToClient.parse({ kind: "event", event: sealedText }).kind).toBe("event");
    expect(
      HubToClient.parse({ kind: "patch", conv: "cnv_1", eventId: "evt_1", markdown: "x" }).kind
    ).toBe("patch");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -w packages/protocol`
Expected: FAIL，`Failed to resolve import "../src/wire.js"`。

- [ ] **Step 3: 实现 wire.ts**

`packages/protocol/src/wire.ts`：

```ts
import { z } from "zod";
import { Event, EventDraft } from "./event.js";

// ---------- daemon → hub ----------

export const MachineInfo = z.object({
  id: z.string().startsWith("mch_"),
  name: z.string(),
});
export type MachineInfo = z.infer<typeof MachineInfo>;

export const DaemonHello = z.object({
  kind: z.literal("hello"),
  machine: MachineInfo,
  dirs: z.array(z.string()),
  maxConcurrent: z.number().int().positive(),
});

export const DaemonEvent = z.object({
  kind: z.literal("event"),
  event: EventDraft,
});

// 流式增量：整段替换 eventId 对应 text 事件的 markdown（幂等，丢一条不碎）
export const DaemonPatch = z.object({
  kind: z.literal("patch"),
  conv: z.string(),
  eventId: z.string(),
  markdown: z.string(),
});

// 会话与 agent session 绑定（resume 用），任务启动成功后上报
export const DaemonSession = z.object({
  kind: z.literal("session"),
  conv: z.string(),
  agentSessionId: z.string(),
});

export const DaemonToHub = z.discriminatedUnion("kind", [
  DaemonHello,
  DaemonEvent,
  DaemonPatch,
  DaemonSession,
]);
export type DaemonToHub = z.infer<typeof DaemonToHub>;

// ---------- hub → daemon ----------

export const HubTask = z.object({
  kind: z.literal("task"),
  conv: z.string(),
  dir: z.string(),
  agent: z.string(), // "claude-code"，为多 adapter 留口
  agentSessionId: z.string().optional(), // 有则 resume，无则新起
  event: Event, // 用户 text 事件（已盖 seq）
});

export const HubUserEvent = z.object({
  kind: z.literal("user_event"), // 追加消息 / permission_response
  conv: z.string(),
  event: Event,
});

export const HubInterrupt = z.object({
  kind: z.literal("interrupt"),
  conv: z.string(),
});

export const HubToDaemon = z.discriminatedUnion("kind", [
  HubTask,
  HubUserEvent,
  HubInterrupt,
]);
export type HubToDaemon = z.infer<typeof HubToDaemon>;

// ---------- client → hub ----------

export const ClientSubscribe = z.object({
  kind: z.literal("subscribe"),
  conv: z.string(),
  afterSeq: z.number().int().nonnegative(),
});

export const ClientSend = z.object({
  kind: z.literal("send"),
  conv: z.string(),
  event: EventDraft, // text 或 permission_response
});

export const ClientToHub = z.discriminatedUnion("kind", [
  ClientSubscribe,
  ClientSend,
]);
export type ClientToHub = z.infer<typeof ClientToHub>;

// ---------- hub → client ----------

export const HubEvent = z.object({
  kind: z.literal("event"),
  event: Event,
});

export const HubPatch = z.object({
  kind: z.literal("patch"),
  conv: z.string(),
  eventId: z.string(),
  markdown: z.string(),
});

export const HubToClient = z.discriminatedUnion("kind", [HubEvent, HubPatch]);
export type HubToClient = z.infer<typeof HubToClient>;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -w packages/protocol`
Expected: PASS（event + wire 两个文件全绿）。

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/wire.ts packages/protocol/test/wire.test.ts
git commit -m "feat(protocol): 四方向 WS wire 消息 schema"
```

---

### Task 3: REST DTO + id 生成器 + 包入口

**Files:**
- Create: `packages/protocol/src/api.ts`
- Create: `packages/protocol/src/id.ts`
- Create: `packages/protocol/src/index.ts`
- Test: `packages/protocol/test/api.test.ts`

**Interfaces:**
- Consumes: `StatusState`、`PermissionChoice`（Task 1，`./event.js`）。
- Produces:
  - `MachineSummary = { id, name, online: boolean, dirs: string[] }`（GET /api/machines 响应元素）
  - `ConversationSummary = { id, machineId, machineName, dir, state: StatusState, lastMessage, lastSeq, updatedAt }`（GET /api/conversations 响应元素）
  - `NewConversationRequest = { machineId, dir, message }`（POST /api/conversations 请求体）
  - `PermissionResponseRequest = { conv, request_id, choice: PermissionChoice }`（POST /api/permission-response 请求体，锁屏通知 action 用）
  - `DeviceRegistration = { deviceToken: string }`（POST /api/register-device 请求体）
  - `newId(prefix: "evt" | "cnv" | "mch"): string`
  - `src/index.ts` 汇总导出 event/wire/api/id 全部符号——**下游只允许从包根导入**（`import { Event } from "@pager/protocol"`）。

- [ ] **Step 1: 写失败测试**

`packages/protocol/test/api.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import {
  MachineSummary,
  ConversationSummary,
  NewConversationRequest,
  PermissionResponseRequest,
  DeviceRegistration,
  newId,
  Event,
} from "../src/index.js";

describe("REST DTO", () => {
  it("解析 MachineSummary", () => {
    const m = { id: "mch_mac", name: "Mac", online: true, dirs: ["/a"] };
    expect(MachineSummary.parse(m)).toEqual(m);
  });

  it("解析 ConversationSummary 并拒绝非法 state", () => {
    const c = {
      id: "cnv_1",
      machineId: "mch_mac",
      machineName: "Mac",
      dir: "/a",
      state: "running",
      lastMessage: "跑测试中…",
      lastSeq: 42,
      updatedAt: 1751780000,
    };
    expect(ConversationSummary.parse(c)).toEqual(c);
    expect(() => ConversationSummary.parse({ ...c, state: "paused" })).toThrow();
  });

  it("NewConversationRequest 拒绝空 message", () => {
    expect(() =>
      NewConversationRequest.parse({ machineId: "mch_mac", dir: "/a", message: "" })
    ).toThrow();
  });

  it("解析 PermissionResponseRequest 与 DeviceRegistration", () => {
    expect(
      PermissionResponseRequest.parse({ conv: "cnv_1", request_id: "r1", choice: "allow" }).choice
    ).toBe("allow");
    expect(DeviceRegistration.parse({ deviceToken: "abc" }).deviceToken).toBe("abc");
  });
});

describe("newId", () => {
  it("生成带前缀的唯一 id", () => {
    const a = newId("evt");
    const b = newId("evt");
    expect(a).toMatch(/^evt_[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
    expect(newId("cnv").startsWith("cnv_")).toBe(true);
    expect(newId("mch").startsWith("mch_")).toBe(true);
  });
});

describe("index 汇总导出", () => {
  it("包根能拿到 Event", () => {
    expect(typeof Event.parse).toBe("function");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -w packages/protocol`
Expected: FAIL，`Failed to resolve import "../src/index.js"`。

- [ ] **Step 3: 实现 api.ts / id.ts / index.ts**

`packages/protocol/src/api.ts`：

```ts
import { z } from "zod";
import { PermissionChoice, StatusState } from "./event.js";

export const MachineSummary = z.object({
  id: z.string(),
  name: z.string(),
  online: z.boolean(),
  dirs: z.array(z.string()),
});
export type MachineSummary = z.infer<typeof MachineSummary>;

export const ConversationSummary = z.object({
  id: z.string(),
  machineId: z.string(),
  machineName: z.string(),
  dir: z.string(),
  state: StatusState,
  lastMessage: z.string(),
  lastSeq: z.number().int().nonnegative(),
  updatedAt: z.number().int(),
});
export type ConversationSummary = z.infer<typeof ConversationSummary>;

export const NewConversationRequest = z.object({
  machineId: z.string(),
  dir: z.string(),
  message: z.string().min(1),
});
export type NewConversationRequest = z.infer<typeof NewConversationRequest>;

export const PermissionResponseRequest = z.object({
  conv: z.string(),
  request_id: z.string(),
  choice: PermissionChoice,
});
export type PermissionResponseRequest = z.infer<typeof PermissionResponseRequest>;

export const DeviceRegistration = z.object({
  deviceToken: z.string(),
});
export type DeviceRegistration = z.infer<typeof DeviceRegistration>;
```

`packages/protocol/src/id.ts`：

```ts
export type IdPrefix = "evt" | "cnv" | "mch";

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${crypto.randomUUID()}`;
}
```

`packages/protocol/src/index.ts`：

```ts
export * from "./event.js";
export * from "./wire.js";
export * from "./api.js";
export * from "./id.js";
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -w packages/protocol`
Expected: PASS，三个测试文件全绿。

- [ ] **Step 5: 全包构建收尾**

Run: `npm run build -w packages/protocol && npm test`
Expected: dist/ 含 event/wire/api/id/index 的 js+d.ts；根 `npm test` 全绿。

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src packages/protocol/test
git commit -m "feat(protocol): REST DTO、newId 与包入口"
```
