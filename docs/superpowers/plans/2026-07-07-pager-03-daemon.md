# Pager 03 — Daemon（每台机器的执行端）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 `daemon/`：Node 常驻进程，连上生产 hub（wss://pager-hub.jianshuo.workers.dev），用 `@anthropic-ai/claude-agent-sdk` 在白名单目录里起/续 Claude Code 会话，把 SDK 事件翻译成 `@pager/protocol` 事件上行，桥接权限请求。最终里程碑：**装到这台 Mac（launchd），curl 一条消息就能指挥本机 Claude Code 干活并全程在 hub 可见**。

**Architecture:** 胖 daemon（spec 第 2 节 + 01/02 落地约定）。分层：`config`（zod 配置）→ `state`（conv→{agentSessionId,dir} 本地持久化，hub 不回传此映射）→ `hub`（WS 客户端，指数退避重连 + hello）→ `adapters/claude-code`（SDK 事件 → 协议事件翻译 + canUseTool 权限桥）→ `runner`（task/user_event/interrupt 分发、并发闸、权限等待/超时 deny）→ `index`（组装）。

**Tech Stack:** TypeScript strict NodeNext ESM（同 protocol 包，相对导入带 `.js`）、`@anthropic-ai/claude-agent-sdk`（装最新版）、`ws` ^8、zod v3、vitest（普通 Node 环境，不用 workers pool）、launchd（Mac 常驻）。

## 事实依据（防猜 API）

- **参考实现**：`/Users/jianshuo/code/jianshuo.dev/claude-agent/src/server.ts` 是同一台机器上已跑通的 Agent SDK 用法（query、includePartialMessages 流式、abortController 取消）。写 adapter 前必须先读它，以它和实际安装版本的类型定义（`node_modules/@anthropic-ai/claude-agent-sdk/*.d.ts`）为准，本计划中 adapter 代码是**参考形状**，字段名以实物为准，偏离要在报告里写明。
- **fixture 录制**：adapter 的测试不猜消息格式——先用 `daemon/scripts/record-fixture.mjs` 跑一次真 SDK 把消息流录成 JSONL，测试回放这个 fixture 断言不变量（有 session id、有文本事件+最终 patch、结尾 status done）。SDK 升级导致解析失败时重录 fixture 重校准（codex-agent 已验证此法）。

## 已定决策（延续 01/02）

- hub 不回传 conv→agentSessionId：daemon 本地持久化（`~/.pager/state.json`）。
- at-most-once：socket 不在线消息即失；重连要快（1s 起指数退避，封顶 60s）。未知 conv 的 user_event 容忍丢弃。
- 上行事件 `EventDraft`（无 seq）；`EventLoose.body` 可能缺失要容忍。
- 重连时 hub 会以 1012 接管旧 socket（预期，不当错误）。
- 权限：SDK `canUseTool` → `permission_request` 事件 → 等 `permission_response`（配置超时，默认 3600s，超时 deny）。`allow_always` v1 按 allow 处理（会话内白名单留 v2）。
- VPS systemd 部署**不在本计划**（等 04-ios 后有真实需求再做），本计划只装这台 Mac。

## Global Constraints

- `daemon/` 包名 `@pager/daemon`，private；root workspaces 加 `"daemon"`。
- TypeScript strict，NodeNext ESM，相对导入带 `.js`；协议只从 `@pager/protocol` 包根导入；测试/构建前先 `npm run build -w packages/protocol`。
- Node ≥ 20；`engines` 字段带上。
- 时间戳 epoch 秒；id 用协议包 `newId`（evt/cnv/mch），permission request_id 用 `` `req_${crypto.randomUUID()}` ``。
- 配置文件 `~/.pager/daemon.json`（600），路径可用 env `PAGER_DAEMON_CONFIG` 覆盖；日志/状态全放本地路径（launchd 读不了 iCloud）。
- 生产 hub：`https://pager-hub.jianshuo.workers.dev`；token 在 `hub/.secrets.production.local`。
- conventional commits。

---

### Task 1: daemon 脚手架 + 配置加载 + 会话状态持久化

**Files:**
- Modify: `package.json`（根，workspaces 加 `"daemon"`）
- Create: `daemon/package.json`
- Create: `daemon/tsconfig.json`
- Create: `daemon/src/config.ts`
- Create: `daemon/src/state.ts`
- Test: `daemon/test/config.test.ts`
- Test: `daemon/test/state.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `DaemonConfig`（zod）：`{ hubUrl, daemonToken, machineId: "mch_*", machineName, dirs: string[]≥1, maxConcurrent=4, permissionTimeoutSec=3600, permissionMode="default" }`；`loadConfig(path?)` 从 JSON 文件读并校验。
  - `SessionStore`：`load()` / `get(conv): {agentSessionId?, dir} | undefined` / `set(conv, patch)`（merge 写盘，目录自动创建）。构造参数为文件路径。

- [ ] **Step 1: 根 workspaces 加 daemon**

`package.json`（根）`"workspaces"` 改为：

```json
"workspaces": ["packages/*", "hub", "daemon"]
```

- [ ] **Step 2: 写包配置**

`daemon/package.json`：

```json
{
  "name": "@pager/daemon",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "latest",
    "@pager/protocol": "0.1.0",
    "ws": "^8.18.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "@types/ws": "^8.5.0",
    "typescript": "^5.5.0",
    "vitest": "^2.1.0"
  },
  "engines": { "node": ">=20" }
}
```

（`npm install` 后把 `"latest"` 固定成解析出的具体版本号，写回 package.json。）

`daemon/tsconfig.json`：

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "types": ["node"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: 安装依赖**

Run: `npm install`（根）→ 无 error；然后 `npm view @anthropic-ai/claude-agent-sdk version` 把版本固定进 daemon/package.json 再 `npm install` 一次。

- [ ] **Step 4: 写失败测试**

`daemon/test/config.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonConfig, loadConfig } from "../src/config.js";

const VALID = {
  hubUrl: "https://pager-hub.jianshuo.workers.dev",
  daemonToken: "tok",
  machineId: "mch_mac",
  machineName: "建硕的 Mac",
  dirs: ["/tmp/pager-e2e"],
};

describe("DaemonConfig", () => {
  it("合法配置解析并给默认值", () => {
    const c = DaemonConfig.parse(VALID);
    expect(c.maxConcurrent).toBe(4);
    expect(c.permissionTimeoutSec).toBe(3600);
    expect(c.permissionMode).toBe("default");
  });

  it("machineId 前缀错误拒绝", () => {
    expect(() => DaemonConfig.parse({ ...VALID, machineId: "mac" })).toThrow();
  });

  it("dirs 空数组拒绝", () => {
    expect(() => DaemonConfig.parse({ ...VALID, dirs: [] })).toThrow();
  });

  it("loadConfig 从文件读", () => {
    const dir = mkdtempSync(join(tmpdir(), "pager-cfg-"));
    const p = join(dir, "daemon.json");
    writeFileSync(p, JSON.stringify({ ...VALID, maxConcurrent: 2 }));
    expect(loadConfig(p).maxConcurrent).toBe(2);
  });
});
```

`daemon/test/state.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/state.js";

describe("SessionStore", () => {
  it("set/get 并跨实例持久化（merge 语义）", () => {
    const file = join(mkdtempSync(join(tmpdir(), "pager-state-")), "sub", "state.json");
    const a = new SessionStore(file);
    a.load();
    expect(a.get("cnv_1")).toBeUndefined();
    a.set("cnv_1", { dir: "/proj" });
    a.set("cnv_1", { agentSessionId: "s-1" });

    const b = new SessionStore(file);
    b.load();
    expect(b.get("cnv_1")).toEqual({ dir: "/proj", agentSessionId: "s-1" });
  });

  it("文件缺失/损坏时 load 得到空表", () => {
    const file = join(mkdtempSync(join(tmpdir(), "pager-state-")), "state.json");
    const s = new SessionStore(file);
    s.load();
    expect(s.get("cnv_x")).toBeUndefined();
  });
});
```

- [ ] **Step 5: 跑测试确认失败**

Run: `npm run build -w packages/protocol && npm test -w daemon`
Expected: FAIL（模块不存在）。

- [ ] **Step 6: 实现 config.ts 与 state.ts**

`daemon/src/config.ts`：

```ts
import { z } from "zod";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DaemonConfig = z.object({
  hubUrl: z.string().url(),
  daemonToken: z.string().min(1),
  machineId: z.string().startsWith("mch_"),
  machineName: z.string().min(1),
  dirs: z.array(z.string().min(1)).min(1),
  maxConcurrent: z.number().int().positive().default(4),
  permissionTimeoutSec: z.number().int().positive().default(3600),
  permissionMode: z.string().default("default"),
});
export type DaemonConfig = z.infer<typeof DaemonConfig>;

export function defaultConfigPath(): string {
  return process.env.PAGER_DAEMON_CONFIG ?? join(homedir(), ".pager", "daemon.json");
}

export function loadConfig(path = defaultConfigPath()): DaemonConfig {
  return DaemonConfig.parse(JSON.parse(readFileSync(path, "utf8")));
}
```

`daemon/src/state.ts`：

```ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface ConvState {
  agentSessionId?: string;
  dir?: string;
}

// conv → 会话状态。hub 不回传 agentSessionId 映射，daemon 自己持久化（重启后可 resume）
export class SessionStore {
  private map: Record<string, ConvState> = {};

  constructor(private file: string) {}

  load(): void {
    try {
      this.map = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      this.map = {};
    }
  }

  get(conv: string): ConvState | undefined {
    return this.map[conv];
  }

  set(conv: string, patch: ConvState): void {
    this.map[conv] = { ...this.map[conv], ...patch };
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.map, null, 2));
  }
}
```

- [ ] **Step 7: 跑测试确认通过 + typecheck**

Run: `npm test -w daemon && npm run typecheck -w daemon`
Expected: 6 个用例全绿。

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json daemon
git commit -m "feat(daemon): 脚手架、配置加载与会话状态持久化"
```

---

### Task 2: HubClient——WS 连接、hello、指数退避重连

**Files:**
- Create: `daemon/src/hub.ts`
- Test: `daemon/test/hub.test.ts`

**Interfaces:**
- Consumes: `DaemonToHub`、`HubToDaemon`（`@pager/protocol`）。
- Produces: `HubClient`：
  - `new HubClient(opts: { hubUrl, daemonToken, machineId, baseBackoffMs?=1000, maxBackoffMs?=60000 }, handlers: { onOpen(): void; onMessage(msg: HubToDaemon): void })`
  - `connect()`：拼 `wss(s)://.../ws/daemon?machine=<id>`（http→ws 替换），header Bearer；open 时重置退避并回调 `onOpen`（main 在这里发 hello）；message 时 `HubToDaemon.parse` 后回调（解析失败丢弃并 console.error）；close/error 后按退避重连。
  - `send(msg: DaemonToHub): boolean`（socket 非 OPEN 返回 false 丢弃——at-most-once）。
  - `close()`：停止重连并关 socket。

- [ ] **Step 1: 写失败测试**

`daemon/test/hub.test.ts`（用 `ws` 起本地假 hub）：

```ts
import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import type { AddressInfo } from "node:net";
import { HubClient } from "../src/hub.js";

function until<T>(fn: () => T | undefined | null | false, ms = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const t = setInterval(() => {
      const v = fn();
      if (v) { clearInterval(t); resolve(v); }
      else if (Date.now() - start > ms) { clearInterval(t); reject(new Error("until timeout")); }
    }, 20);
  });
}

let servers: WebSocketServer[] = [];
let clients: HubClient[] = [];
afterEach(() => {
  clients.forEach((c) => c.close());
  servers.forEach((s) => s.close());
  clients = []; servers = [];
});

function fakeHub() {
  const wss = new WebSocketServer({ port: 0 });
  servers.push(wss);
  const state: { sockets: ServerSocket[]; received: any[]; headers: any[] } = { sockets: [], received: [], headers: [] };
  wss.on("connection", (socket, req) => {
    state.sockets.push(socket);
    state.headers.push(req.headers);
    socket.on("message", (d) => state.received.push(JSON.parse(d.toString())));
  });
  const port = (wss.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, state };
}

function makeClient(url: string, onMessage: (m: any) => void = () => {}) {
  const got = { opened: 0 };
  const c = new HubClient(
    { hubUrl: url, daemonToken: "tok", machineId: "mch_t", baseBackoffMs: 50, maxBackoffMs: 200 },
    { onOpen: () => { got.opened++; }, onMessage }
  );
  clients.push(c);
  return { c, got };
}

describe("HubClient", () => {
  it("连接带 Bearer 头与 machine 参数，open 回调触发，send 上行", async () => {
    const hub = fakeHub();
    const { c, got } = makeClient(hub.url);
    c.connect();
    await until(() => got.opened === 1);
    expect(hub.state.headers[0].authorization).toBe("Bearer tok");
    c.send({ kind: "patch", conv: "cnv_1", eventId: "evt_1", markdown: "hi" });
    await until(() => hub.state.received.length === 1);
    expect(hub.state.received[0].kind).toBe("patch");
  });

  it("收到合法 HubToDaemon 回调，非法消息丢弃不炸", async () => {
    const hub = fakeHub();
    const msgs: any[] = [];
    const { c, got } = makeClient(hub.url, (m) => msgs.push(m));
    c.connect();
    await until(() => got.opened === 1);
    hub.state.sockets[0].send("not json");
    hub.state.sockets[0].send(JSON.stringify({ kind: "nope" }));
    hub.state.sockets[0].send(JSON.stringify({ kind: "interrupt", conv: "cnv_1" }));
    await until(() => msgs.length === 1);
    expect(msgs[0]).toEqual({ kind: "interrupt", conv: "cnv_1" });
  });

  it("服务端断开后自动重连", async () => {
    const hub = fakeHub();
    const { c, got } = makeClient(hub.url);
    c.connect();
    await until(() => got.opened === 1);
    hub.state.sockets[0].close();
    await until(() => got.opened === 2);
    expect(got.opened).toBe(2);
  });

  it("close() 后不再重连，未连接时 send 返回 false", async () => {
    const hub = fakeHub();
    const { c, got } = makeClient(hub.url);
    c.connect();
    await until(() => got.opened === 1);
    c.close();
    expect(c.send({ kind: "patch", conv: "c", eventId: "e", markdown: "x" })).toBe(false);
    await new Promise((r) => setTimeout(r, 300));
    expect(got.opened).toBe(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -w daemon` → hub 用例 FAIL。

- [ ] **Step 3: 实现 hub.ts**

`daemon/src/hub.ts`：

```ts
import WebSocket from "ws";
import { HubToDaemon, type DaemonToHub } from "@pager/protocol";

export interface HubClientOptions {
  hubUrl: string;
  daemonToken: string;
  machineId: string;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

export interface HubHandlers {
  onOpen(): void;
  onMessage(msg: HubToDaemon): void;
}

export class HubClient {
  private ws: WebSocket | null = null;
  private closed = false;
  private backoff: number;
  private readonly base: number;
  private readonly max: number;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private opts: HubClientOptions, private handlers: HubHandlers) {
    this.base = opts.baseBackoffMs ?? 1000;
    this.max = opts.maxBackoffMs ?? 60_000;
    this.backoff = this.base;
  }

  connect(): void {
    if (this.closed) return;
    const url = `${this.opts.hubUrl.replace(/^http/, "ws")}/ws/daemon?machine=${this.opts.machineId}`;
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${this.opts.daemonToken}` } });
    this.ws = ws;

    ws.on("open", () => {
      this.backoff = this.base;
      this.handlers.onOpen();
    });
    ws.on("message", (data) => {
      let msg: HubToDaemon;
      try {
        msg = HubToDaemon.parse(JSON.parse(data.toString()));
      } catch (err) {
        console.error("hub message dropped:", err);
        return;
      }
      this.handlers.onMessage(msg);
    });
    ws.on("close", () => this.scheduleReconnect());
    ws.on("error", () => {
      /* close 事件随后触发，重连在那里排 */
    });
  }

  send(msg: DaemonToHub): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false; // at-most-once：不在线即丢
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    this.timer = setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, this.max);
  }
}
```

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `npm test -w daemon && npm run typecheck -w daemon` → 全绿。

- [ ] **Step 5: Commit**

```bash
git add daemon
git commit -m "feat(daemon): HubClient——WS 连接、指数退避重连与类型化收发"
```

---

### Task 3: claude-code adapter——SDK 事件翻译 + 权限桥 + fixture

**Files:**
- Create: `daemon/src/adapters/types.ts`
- Create: `daemon/src/adapters/claude-code.ts`
- Create: `daemon/scripts/record-fixture.mjs`
- Create: `daemon/test/fixtures/claude-events.jsonl`（录制产物，提交进库）
- Test: `daemon/test/claude-code.test.ts`

**Interfaces:**
- Consumes: `newId`、`EventDraft` 形状（`@pager/protocol`）；`@anthropic-ai/claude-agent-sdk` 的 `query`。
- Produces:
  - `AgentAdapter`：`run(opts: RunOptions): RunHandle`；`RunHandle = { interrupt(): void; done: Promise<void> }`
  - `RunOptions = { conv, dir, prompt, agentSessionId?, permissionMode, emit(msg: DaemonToHub): void, requestPermission(req: {request_id, tool, description, options}): Promise<"allow"|"deny"|"allow_always"> }`
  - `createClaudeCodeAdapter(queryFn?)`——`queryFn` 默认真 SDK `query`，测试注入假的。
  - 翻译约定：SDK init → `{kind:"session"}`；流式文本 → 先发空 text 事件再每 ≥400ms 发 `{kind:"patch"}`（整段替换），block 结束发最终 patch；tool_use+tool_result 配对 → 一张 `tool_card`（title 一行人话、detail 截断 4000 字符、Edit/Write 带 diff 字段可留空）；result → `status done/failed`；canUseTool → `permission_request` 事件 + await 响应（deny 回 SDK deny）。

**⚠️ 本 task 的代码是参考形状**：动手前先读 `/Users/jianshuo/code/jianshuo.dev/claude-agent/src/server.ts` 与安装版 SDK 的 `.d.ts`，字段名（`msg.type`/`stream_event`/`session_id`/`canUseTool` 签名等）以实物为准；每处偏离在报告里列出。

- [ ] **Step 1: 写录制脚本**

`daemon/scripts/record-fixture.mjs`：

```js
// 用真 SDK 在临时目录跑一个小任务，把消息流录成 JSONL（提交进库做回放测试）
// 用法：node daemon/scripts/record-fixture.mjs
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "pager-fixture-"));
const lines = [];
const q = query({
  prompt: "把 1+1 的结果写进 answer.txt，然后简短说明你做了什么。",
  options: {
    cwd: dir,
    includePartialMessages: true,
    permissionMode: "acceptEdits",
    maxTurns: 10,
  },
});
for await (const msg of q) {
  lines.push(JSON.stringify(msg));
  console.error(msg.type);
}
const out = new URL("../test/fixtures/claude-events.jsonl", import.meta.url).pathname;
writeFileSync(out, lines.join("\n") + "\n");
console.log(`recorded ${lines.length} messages → ${out}`);
```

- [ ] **Step 2: 录制 fixture**

Run: `mkdir -p daemon/test/fixtures && node daemon/scripts/record-fixture.mjs`
Expected: 输出 `recorded N messages`，fixture 文件生成（本机已登录 Claude Code，SDK 用本地凭证）。**读一遍 fixture 首尾几行**，确认消息形状后再写翻译代码；若形状与本计划参考代码不符，以 fixture 为准调整。

- [ ] **Step 3: 写失败测试（回放 fixture 断言不变量）**

`daemon/test/claude-code.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createClaudeCodeAdapter } from "../src/adapters/claude-code.js";

function fixtureMessages(): any[] {
  const raw = readFileSync(new URL("./fixtures/claude-events.jsonl", import.meta.url), "utf8");
  return raw.trim().split("\n").map((l) => JSON.parse(l));
}

function fakeQuery(messages: any[]) {
  return () => (async function* () { for (const m of messages) yield m; })();
}

async function run(messages: any[], over: Partial<Parameters<ReturnType<typeof createClaudeCodeAdapter>["run"]>[0]> = {}) {
  const emitted: any[] = [];
  const adapter = createClaudeCodeAdapter(fakeQuery(messages) as any);
  const handle = adapter.run({
    conv: "cnv_t",
    dir: "/tmp",
    prompt: "test",
    permissionMode: "default",
    emit: (m) => emitted.push(m),
    requestPermission: async () => "allow",
    ...over,
  });
  await handle.done;
  return emitted;
}

describe("claude-code adapter（fixture 回放）", () => {
  it("翻译不变量：session → running → 文本+最终patch → done", async () => {
    const emitted = await run(fixtureMessages());

    const session = emitted.find((m) => m.kind === "session");
    expect(session?.agentSessionId).toBeTruthy();

    const statuses = emitted
      .filter((m) => m.kind === "event" && m.event.type === "status")
      .map((m) => m.event.body.state);
    expect(statuses[0]).toBe("running");
    expect(statuses[statuses.length - 1]).toBe("done");

    const textEvents = emitted.filter((m) => m.kind === "event" && m.event.type === "text");
    expect(textEvents.length).toBeGreaterThan(0);
    const patches = emitted.filter((m) => m.kind === "patch");
    expect(patches.length).toBeGreaterThan(0);
    expect(patches[patches.length - 1].markdown.length).toBeGreaterThan(0);

    // fixture 里有写文件动作 → 应有 tool_card
    const cards = emitted.filter((m) => m.kind === "event" && m.event.type === "tool_card");
    expect(cards.length).toBeGreaterThan(0);
    expect(cards[0].event.body.title.length).toBeGreaterThan(0);

    // 所有上行事件 conv 正确且无 seq
    for (const m of emitted) {
      if (m.kind === "event") {
        expect(m.event.conv).toBe("cnv_t");
        expect(m.event).not.toHaveProperty("seq");
      }
    }
  });

  it("canUseTool 桥：deny 返回 SDK deny 且发 permission_request", async () => {
    // 构造一个会触发 canUseTool 的假 queryFn
    const emitted: any[] = [];
    let sdkDecision: any = null;
    const adapter = createClaudeCodeAdapter(((args: any) =>
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "s-perm" };
        sdkDecision = await args.options.canUseTool("Bash", { command: "rm -rf /tmp/x" });
        yield { type: "result", subtype: "success", is_error: false };
      })()) as any);
    const handle = adapter.run({
      conv: "cnv_p",
      dir: "/tmp",
      prompt: "t",
      permissionMode: "default",
      emit: (m) => emitted.push(m),
      requestPermission: async (req) => {
        expect(req.tool).toBe("Bash");
        expect(req.request_id.startsWith("req_")).toBe(true);
        expect(req.description).toContain("rm -rf");
        return "deny";
      },
    });
    await handle.done;
    expect(sdkDecision.behavior).toBe("deny");
    const pr = emitted.find((m) => m.kind === "event" && m.event.type === "permission_request");
    expect(pr).toBeTruthy();
  });

  it("SDK 异常 → status failed（不 throw 出去）", async () => {
    const adapter = createClaudeCodeAdapter((() =>
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "s-err" };
        throw new Error("boom");
      })()) as any);
    const emitted: any[] = [];
    const handle = adapter.run({
      conv: "cnv_e", dir: "/tmp", prompt: "t", permissionMode: "default",
      emit: (m) => emitted.push(m), requestPermission: async () => "allow",
    });
    await handle.done; // 不应 reject
    const last = emitted.filter((m) => m.kind === "event" && m.event.type === "status").pop();
    expect(last.event.body.state).toBe("failed");
  });
});
```

Run: `npm test -w daemon` → FAIL（adapter 不存在）。

- [ ] **Step 4: 实现 adapter**

`daemon/src/adapters/types.ts`：

```ts
import type { DaemonToHub, PermissionChoice } from "@pager/protocol";

export interface PermissionRequest {
  request_id: string;
  tool: string;
  description: string;
  options: PermissionChoice[];
}

export interface RunOptions {
  conv: string;
  dir: string;
  prompt: string;
  agentSessionId?: string;
  permissionMode: string;
  emit(msg: DaemonToHub): void;
  requestPermission(req: PermissionRequest): Promise<PermissionChoice>;
}

export interface RunHandle {
  interrupt(): void;
  done: Promise<void>;
}

export interface AgentAdapter {
  run(opts: RunOptions): RunHandle;
}
```

`daemon/src/adapters/claude-code.ts`（参考形状——以 fixture 与 SDK d.ts 为准调整）：

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { newId, type EventDraft } from "@pager/protocol";
import type { AgentAdapter, RunOptions } from "./types.js";

const nowSec = () => Math.floor(Date.now() / 1000);

function draft(conv: string, type: EventDraft["type"], body: unknown, id = newId("evt")): any {
  return { id, conv, ts: nowSec(), role: "agent" as const, agent: "claude-code", type, body };
}

const statusDraft = (conv: string, state: string, note?: string) =>
  draft(conv, "status", note ? { state, note } : { state });

// 把工具调用压成人话标题
function toolTitle(name: string, input: any): string {
  if (name === "Bash" && typeof input?.command === "string") return input.command.slice(0, 80);
  if (typeof input?.file_path === "string") return `${name} ${input.file_path}`;
  if (typeof input?.pattern === "string") return `${name} ${input.pattern}`;
  return name;
}

function toolDetail(input: any, resultText: string): string {
  const inputStr = JSON.stringify(input ?? {}, null, 2);
  return `输入:\n${inputStr.slice(0, 1500)}\n\n输出:\n${resultText.slice(0, 2500)}`;
}

function resultText(block: any): string {
  const c = block?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b: any) => (typeof b?.text === "string" ? b.text : "")).join("\n");
  return "";
}

export function createClaudeCodeAdapter(queryFn: typeof query = query): AgentAdapter {
  return {
    run(opts: RunOptions) {
      const abort = new AbortController();
      const done = runLoop(opts, queryFn, abort).catch((err) => {
        opts.emit({ kind: "event", event: statusDraft(opts.conv, "failed", String(err).slice(0, 300)) });
      });
      return { interrupt: () => abort.abort(), done };
    },
  };
}

async function runLoop(opts: RunOptions, queryFn: typeof query, abort: AbortController): Promise<void> {
  opts.emit({ kind: "event", event: statusDraft(opts.conv, "running") });

  const q = queryFn({
    prompt: opts.prompt,
    options: {
      cwd: opts.dir,
      resume: opts.agentSessionId,
      abortController: abort,
      includePartialMessages: true,
      permissionMode: opts.permissionMode as any,
      canUseTool: async (toolName: string, input: unknown) => {
        const request_id = `req_${crypto.randomUUID()}`;
        opts.emit({
          kind: "event",
          event: draft(opts.conv, "permission_request", {
            request_id,
            tool: toolName,
            description: toolTitle(toolName, input),
            options: ["allow", "deny"],
          }),
        });
        const choice = await opts.requestPermission({
          request_id,
          tool: toolName,
          description: toolTitle(toolName, input),
          options: ["allow", "deny"],
        });
        return choice === "deny"
          ? { behavior: "deny" as const, message: "用户在 Pager 上拒绝了此操作" }
          : { behavior: "allow" as const, updatedInput: input };
      },
    } as any,
  });

  let textId: string | null = null;
  let textBuf = "";
  let lastPatch = 0;
  const pendingTools = new Map<string, { name: string; input: any }>();

  const flushText = () => {
    if (textId && textBuf) opts.emit({ kind: "patch", conv: opts.conv, eventId: textId, markdown: textBuf });
  };

  for await (const msg of q as AsyncIterable<any>) {
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init" && msg.session_id)
          opts.emit({ kind: "session", conv: opts.conv, agentSessionId: msg.session_id });
        break;

      case "stream_event": {
        const ev = msg.event;
        if (ev?.type === "content_block_start" && ev.content_block?.type === "text") {
          textId = newId("evt");
          textBuf = "";
          lastPatch = 0;
          opts.emit({ kind: "event", event: draft(opts.conv, "text", { markdown: "" }, textId) });
        } else if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && textId) {
          textBuf += ev.delta.text;
          if (Date.now() - lastPatch >= 400) {
            lastPatch = Date.now();
            flushText();
          }
        } else if (ev?.type === "content_block_stop" && textId) {
          flushText();
          textId = null;
        }
        break;
      }

      case "assistant": {
        for (const block of msg.message?.content ?? []) {
          if (block.type === "tool_use") pendingTools.set(block.id, { name: block.name, input: block.input });
        }
        break;
      }

      case "user": {
        const content = msg.message?.content;
        if (!Array.isArray(content)) break;
        for (const block of content) {
          if (block.type === "tool_result") {
            const t = pendingTools.get(block.tool_use_id);
            if (!t) continue;
            pendingTools.delete(block.tool_use_id);
            opts.emit({
              kind: "event",
              event: draft(opts.conv, "tool_card", {
                tool: t.name,
                title: toolTitle(t.name, t.input),
                summary: "",
                detail: toolDetail(t.input, resultText(block)),
              }),
            });
          }
        }
        break;
      }

      case "result": {
        flushText();
        const failed = msg.is_error === true;
        opts.emit({
          kind: "event",
          event: statusDraft(opts.conv, failed ? "failed" : "done", failed ? String(msg.subtype ?? "") : undefined),
        });
        break;
      }
    }
  }
}
```

- [ ] **Step 5: 跑测试确认通过 + typecheck**

Run: `npm test -w daemon && npm run typecheck -w daemon` → 全绿（fixture 回放 + 权限桥 + 异常路径）。

- [ ] **Step 6: Commit**

```bash
git add daemon
git commit -m "feat(daemon): claude-code adapter——SDK 事件翻译、权限桥与 fixture 回放测试"
```

---

### Task 4: Runner——任务分发、并发闸、权限等待与超时

**Files:**
- Create: `daemon/src/runner.ts`
- Test: `daemon/test/runner.test.ts`

**Interfaces:**
- Consumes: `AgentAdapter`/`RunOptions`（Task 3）、`SessionStore`（Task 1）、`HubToDaemon`/`PermissionChoice`（协议）。
- Produces: `Runner`：
  - `new Runner(cfg: { maxConcurrent, permissionTimeoutSec, permissionMode }, adapter, store, send: (msg: DaemonToHub) => void)`
  - `handle(msg: HubToDaemon)`：
    - `task` → store.set(conv,{dir}) → 起跑（并发满则入队并发 status thinking + note "排队中"）
    - `user_event`/text → 该 conv 空闲则以 resume 起跑（store 里有 agentSessionId/dir）；忙则排进该 conv 的追加队列，当前跑完自动续
    - `user_event`/permission_response → resolve 等待中的权限（按 request_id）；没人等则丢弃
    - `interrupt` → 该 conv running 则 `interrupt()`
    - 未知 conv / 未知类型 → 容忍丢弃
  - 权限：adapter 的 `requestPermission` 由 Runner 提供——注册 `request_id` → 等 response 或 `permissionTimeoutSec` 超时（超时 resolve "deny" 并发 status note "权限请求超时，已自动拒绝"）
  - run 结束（done resolve）：释放并发位、跑该 conv 追加队列或全局等待队列。

- [ ] **Step 1: 写失败测试**

`daemon/test/runner.test.ts`：

```ts
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runner } from "../src/runner.js";
import { SessionStore } from "../src/state.js";
import type { AgentAdapter, RunOptions } from "../src/adapters/types.js";

function makeStore() {
  const s = new SessionStore(join(mkdtempSync(join(tmpdir(), "pager-run-")), "state.json"));
  s.load();
  return s;
}

// 可手动完成的假 adapter
function fakeAdapter() {
  const runs: Array<{ opts: RunOptions; finish: () => void; interrupted: boolean }> = [];
  const adapter: AgentAdapter = {
    run(opts) {
      let resolve!: () => void;
      const done = new Promise<void>((r) => (resolve = r));
      const rec = { opts, finish: resolve, interrupted: false };
      runs.push(rec);
      return { interrupt: () => { rec.interrupted = true; resolve(); }, done };
    },
  };
  return { adapter, runs };
}

const textEvent = (conv: string, md: string) => ({
  id: "evt_u", conv, seq: 1, ts: 1, role: "user", agent: "claude-code",
  type: "text", body: { markdown: md },
});

const task = (conv: string, dir = "/proj") => ({
  kind: "task" as const, conv, dir, agent: "claude-code", event: textEvent(conv, "do it"),
});

function make(cfg: Partial<{ maxConcurrent: number; permissionTimeoutSec: number }> = {}) {
  const { adapter, runs } = fakeAdapter();
  const sent: any[] = [];
  const store = makeStore();
  const runner = new Runner(
    { maxConcurrent: cfg.maxConcurrent ?? 2, permissionTimeoutSec: cfg.permissionTimeoutSec ?? 3600, permissionMode: "default" },
    adapter, store, (m) => sent.push(m)
  );
  return { runner, runs, sent, store };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

describe("Runner", () => {
  it("task 起跑并记 dir；结束后释放并发位", async () => {
    const { runner, runs, store } = make();
    runner.handle(task("cnv_1"));
    await tick();
    expect(runs.length).toBe(1);
    expect(runs[0].opts.prompt).toBe("do it");
    expect(store.get("cnv_1")?.dir).toBe("/proj");
    runs[0].finish();
    await tick();
  });

  it("并发闸：第 3 个 task 排队并发 thinking 状态，空位后起跑", async () => {
    const { runner, runs, sent } = make({ maxConcurrent: 2 });
    runner.handle(task("cnv_1"));
    runner.handle(task("cnv_2"));
    runner.handle(task("cnv_3"));
    await tick();
    expect(runs.length).toBe(2);
    const queued = sent.find((m) => m.kind === "event" && m.event.conv === "cnv_3" && m.event.type === "status");
    expect(queued.event.body.state).toBe("thinking");
    runs[0].finish();
    await tick();
    expect(runs.length).toBe(3);
    expect(runs[2].opts.conv).toBe("cnv_3");
  });

  it("追加消息：conv 忙则排队跑完自动续（带 resume），空闲直接起跑", async () => {
    const { runner, runs, store } = make();
    runner.handle(task("cnv_1"));
    await tick();
    store.set("cnv_1", { agentSessionId: "s-1" });
    runner.handle({ kind: "user_event", conv: "cnv_1", event: textEvent("cnv_1", "追加") as any });
    await tick();
    expect(runs.length).toBe(1); // 还在忙，先排队
    runs[0].finish();
    await tick();
    expect(runs.length).toBe(2);
    expect(runs[1].opts.prompt).toBe("追加");
    expect(runs[1].opts.agentSessionId).toBe("s-1");
  });

  it("permission_response 解析等待中的权限；超时自动 deny", async () => {
    vi.useFakeTimers();
    const { runner, runs, sent } = make({ permissionTimeoutSec: 5 });
    runner.handle(task("cnv_1"));
    await vi.advanceTimersByTimeAsync(10);

    // adapter 发起权限请求
    const p1 = runs[0].opts.requestPermission({ request_id: "req_a", tool: "Bash", description: "x", options: ["allow", "deny"] });
    runner.handle({
      kind: "user_event", conv: "cnv_1",
      event: { ...textEvent("cnv_1", ""), type: "permission_response", body: { request_id: "req_a", choice: "allow" } } as any,
    });
    await expect(p1).resolves.toBe("allow");

    // 第二个请求超时
    const p2 = runs[0].opts.requestPermission({ request_id: "req_b", tool: "Bash", description: "y", options: ["allow", "deny"] });
    await vi.advanceTimersByTimeAsync(5_100);
    await expect(p2).resolves.toBe("deny");
    const note = sent.find((m) => m.kind === "event" && m.event.type === "status" && m.event.body.note?.includes("超时"));
    expect(note).toBeTruthy();
    vi.useRealTimers();
  });

  it("interrupt 只打断该 conv；未知 conv 的消息容忍", async () => {
    const { runner, runs } = make();
    runner.handle(task("cnv_1"));
    runner.handle(task("cnv_2"));
    await tick();
    runner.handle({ kind: "interrupt", conv: "cnv_1" });
    expect(runs[0].interrupted).toBe(true);
    expect(runs[1].interrupted).toBe(false);
    runner.handle({ kind: "interrupt", conv: "cnv_ghost" }); // 不炸
    runner.handle({ kind: "user_event", conv: "cnv_ghost", event: textEvent("cnv_ghost", "?") as any }); // 无 dir，丢弃不炸
  });
});
```

Run: `npm test -w daemon` → FAIL。

- [ ] **Step 2: 实现 runner.ts**

`daemon/src/runner.ts`：

```ts
import { newId, type DaemonToHub, type HubToDaemon, type PermissionChoice } from "@pager/protocol";
import type { AgentAdapter, PermissionRequest } from "./adapters/types.js";
import type { SessionStore } from "./state.js";

const nowSec = () => Math.floor(Date.now() / 1000);

interface RunnerConfig {
  maxConcurrent: number;
  permissionTimeoutSec: number;
  permissionMode: string;
}

interface ConvRuntime {
  running: boolean;
  interrupt?: () => void;
  followups: string[]; // 排队的追加消息
}

interface QueuedStart {
  conv: string;
  prompt: string;
}

export class Runner {
  private convs = new Map<string, ConvRuntime>();
  private active = 0;
  private startQueue: QueuedStart[] = [];
  private pendingPermissions = new Map<string, (choice: PermissionChoice) => void>();

  constructor(
    private cfg: RunnerConfig,
    private adapter: AgentAdapter,
    private store: SessionStore,
    private send: (msg: DaemonToHub) => void
  ) {}

  handle(msg: HubToDaemon): void {
    switch (msg.kind) {
      case "task": {
        this.store.set(msg.conv, { dir: msg.dir });
        const prompt = msg.event.type === "text" ? (msg.event.body as { markdown: string }).markdown : "";
        this.requestStart(msg.conv, prompt);
        break;
      }
      case "user_event": {
        const ev = msg.event as { type: string; body: unknown };
        if (ev.type === "permission_response") {
          const body = ev.body as { request_id: string; choice: PermissionChoice };
          const resolve = this.pendingPermissions.get(body.request_id);
          if (resolve) {
            this.pendingPermissions.delete(body.request_id);
            resolve(body.choice);
          }
          return;
        }
        if (ev.type === "text") {
          const state = this.store.get(msg.conv);
          if (!state?.dir) return; // 未知 conv：容忍丢弃
          const md = (ev.body as { markdown: string }).markdown;
          const rt = this.convs.get(msg.conv);
          if (rt?.running) rt.followups.push(md);
          else this.requestStart(msg.conv, md);
        }
        break;
      }
      case "interrupt":
        this.convs.get(msg.conv)?.interrupt?.();
        break;
    }
  }

  private requestStart(conv: string, prompt: string): void {
    if (this.active >= this.cfg.maxConcurrent) {
      this.startQueue.push({ conv, prompt });
      this.emitStatus(conv, "thinking", `排队中（${this.startQueue.length} 个任务在前面）`);
      return;
    }
    this.start(conv, prompt);
  }

  private start(conv: string, prompt: string): void {
    const state = this.store.get(conv);
    if (!state?.dir) return;
    this.active++;
    const rt: ConvRuntime = { running: true, followups: [] };
    this.convs.set(conv, rt);

    const handle = this.adapter.run({
      conv,
      dir: state.dir,
      prompt,
      agentSessionId: state.agentSessionId,
      permissionMode: this.cfg.permissionMode,
      emit: (m) => {
        if (m.kind === "session") this.store.set(conv, { agentSessionId: m.agentSessionId });
        this.send(m);
      },
      requestPermission: (req) => this.awaitPermission(conv, req),
    });
    rt.interrupt = handle.interrupt;

    void handle.done.finally(() => {
      rt.running = false;
      this.active--;
      const next = rt.followups.shift();
      if (next !== undefined) {
        this.start(conv, next); // 同 conv 续跑（带 resume）
        return;
      }
      const queued = this.startQueue.shift();
      if (queued) this.start(queued.conv, queued.prompt);
    });
  }

  private awaitPermission(conv: string, req: PermissionRequest): Promise<PermissionChoice> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPermissions.delete(req.request_id);
        this.emitStatus(conv, "running", `权限请求超时（${this.cfg.permissionTimeoutSec}s），已自动拒绝：${req.description}`);
        resolve("deny");
      }, this.cfg.permissionTimeoutSec * 1000);
      this.pendingPermissions.set(req.request_id, (choice) => {
        clearTimeout(timer);
        resolve(choice);
      });
    });
  }

  private emitStatus(conv: string, state: string, note?: string): void {
    this.send({
      kind: "event",
      event: {
        id: newId("evt"), conv, ts: nowSec(), role: "system", agent: "claude-code",
        type: "status", body: note ? { state, note } : { state },
      } as never,
    });
  }
}
```

注意：adapter 已经自己发 `permission_request` 事件（Task 3），Runner 只负责等待/超时；两边用同一个 `request_id`（通过 `req` 参数传递）。

- [ ] **Step 3: 跑测试确认通过 + typecheck**

Run: `npm test -w daemon && npm run typecheck -w daemon` → 全绿。

- [ ] **Step 4: Commit**

```bash
git add daemon
git commit -m "feat(daemon): Runner——任务分发、并发闸、权限等待与超时 deny"
```

---

### Task 5: 主入口 + launchd 安装 + 生产端到端验收

**Files:**
- Create: `daemon/src/index.ts`
- Create: `daemon/deploy/install-launchd.sh`
- Create: `daemon/scripts/e2e.mjs`
- Test: 无新增单测（交付物是真机 e2e）

**Interfaces:**
- Consumes: 全部前置模块。
- Produces:
  - `node dist/index.js`：loadConfig → SessionStore.load → Runner → HubClient；open 时发 hello `{kind:"hello", proto:1, machine:{id,name}, dirs, maxConcurrent}`；SIGINT/SIGTERM 优雅退出。
  - `daemon/deploy/install-launchd.sh`：build → 写 `~/.pager/daemon.json`（token 从 `hub/.secrets.production.local` 读，600）→ 写 `~/Library/LaunchAgents/dev.jianshuo.pager.daemon.plist`（KeepAlive、日志 `~/.pager/logs/`、node 绝对路径）→ `launchctl` 加载。幂等（重跑先卸载旧的）。
  - `daemon/scripts/e2e.mjs`：完整验收——客户端 WS 连生产 hub 自动批准权限请求 + REST 建会话让 Claude 在 `/tmp/pager-e2e` 创建文件 + 轮询到 done + 校验文件存在 → `E2E PASS`。

- [ ] **Step 1: 实现 index.ts**

`daemon/src/index.ts`：

```ts
import { join } from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "./config.js";
import { SessionStore } from "./state.js";
import { HubClient } from "./hub.js";
import { Runner } from "./runner.js";
import { createClaudeCodeAdapter } from "./adapters/claude-code.js";

const cfg = loadConfig();
const store = new SessionStore(process.env.PAGER_DAEMON_STATE ?? join(homedir(), ".pager", "state.json"));
store.load();

const client: HubClient = new HubClient(
  { hubUrl: cfg.hubUrl, daemonToken: cfg.daemonToken, machineId: cfg.machineId },
  {
    onOpen() {
      console.log(`connected to ${cfg.hubUrl} as ${cfg.machineId}`);
      client.send({
        kind: "hello",
        proto: 1,
        machine: { id: cfg.machineId, name: cfg.machineName },
        dirs: cfg.dirs,
        maxConcurrent: cfg.maxConcurrent,
      });
    },
    onMessage(msg) {
      runner.handle(msg);
    },
  }
);

const runner = new Runner(
  { maxConcurrent: cfg.maxConcurrent, permissionTimeoutSec: cfg.permissionTimeoutSec, permissionMode: cfg.permissionMode },
  createClaudeCodeAdapter(),
  store,
  (m) => {
    if (!client.send(m)) console.error("hub offline, dropped:", m.kind);
  }
);

client.connect();
console.log("pager daemon started");

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`${sig} received, shutting down`);
    client.close();
    process.exit(0);
  });
}
```

Run: `npm run build -w daemon && npm run typecheck -w daemon` → 编译干净。

- [ ] **Step 2: 写 launchd 安装脚本**

`daemon/deploy/install-launchd.sh`：

```bash
#!/bin/bash
# 安装 pager daemon 为 launchd 常驻服务（幂等，重跑覆盖）
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DAEMON_DIR="$REPO_ROOT/daemon"
SECRETS="$REPO_ROOT/hub/.secrets.production.local"
PAGER_HOME="$HOME/.pager"
PLIST="$HOME/Library/LaunchAgents/dev.jianshuo.pager.daemon.plist"
LABEL="dev.jianshuo.pager.daemon"
NODE_BIN="$(command -v node)"
HUB_URL="${HUB_URL:-https://pager-hub.jianshuo.workers.dev}"
MACHINE_ID="${MACHINE_ID:-mch_mac}"
MACHINE_NAME="${MACHINE_NAME:-建硕的 Mac}"

[ -f "$SECRETS" ] || { echo "缺少 $SECRETS"; exit 1; }
# shellcheck disable=SC1090
source "$SECRETS"   # 提供 DAEMON_TOKEN / CLIENT_TOKEN
[ -n "${DAEMON_TOKEN:-}" ] || { echo "SECRETS 里没有 DAEMON_TOKEN"; exit 1; }

echo "== build =="
(cd "$REPO_ROOT" && npm run build -w packages/protocol && npm run build -w daemon)

echo "== config =="
mkdir -p "$PAGER_HOME/logs" /tmp/pager-e2e
if [ ! -f "$PAGER_HOME/daemon.json" ]; then
  cat > "$PAGER_HOME/daemon.json" <<EOF
{
  "hubUrl": "$HUB_URL",
  "daemonToken": "$DAEMON_TOKEN",
  "machineId": "$MACHINE_ID",
  "machineName": "$MACHINE_NAME",
  "dirs": ["/tmp/pager-e2e", "$HOME/code"],
  "maxConcurrent": 4,
  "permissionTimeoutSec": 3600,
  "permissionMode": "default"
}
EOF
  chmod 600 "$PAGER_HOME/daemon.json"
  echo "已写 $PAGER_HOME/daemon.json"
else
  echo "$PAGER_HOME/daemon.json 已存在，保留"
fi

echo "== launchd =="
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$DAEMON_DIR/dist/index.js</string>
  </array>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$PAGER_HOME/logs/daemon.log</string>
  <key>StandardErrorPath</key><string>$PAGER_HOME/logs/daemon.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
</dict>
</plist>
EOF
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "已加载 $LABEL；日志: $PAGER_HOME/logs/daemon.log"
```

`chmod +x daemon/deploy/install-launchd.sh`

- [ ] **Step 3: 写 e2e 脚本**

`daemon/scripts/e2e.mjs`：

```js
// 生产端到端验收：REST 建会话 → daemon 驱动本机 Claude Code 创建文件 →
// 客户端 WS 全程围观并自动批准权限 → 轮询 done → 校验文件存在
// 用法：source hub/.secrets.production.local && node daemon/scripts/e2e.mjs
import WebSocket from "ws";
import { existsSync, readFileSync, rmSync } from "node:fs";

const HUB = process.env.HUB_URL ?? "https://pager-hub.jianshuo.workers.dev";
const CLIENT_TOKEN = process.env.CLIENT_TOKEN;
const MACHINE_ID = process.env.MACHINE_ID ?? "mch_mac";
const MARKER = `pager-e2e-${Date.now()}`;
const FILE = `/tmp/pager-e2e/${MARKER}.txt`;

if (!CLIENT_TOKEN) { console.error("需要 CLIENT_TOKEN（source hub/.secrets.production.local）"); process.exit(1); }
const fail = (m) => { console.error(`E2E FAIL: ${m}`); process.exit(1); };
const api = (path, init = {}) =>
  fetch(`${HUB}${path}`, { ...init, headers: { Authorization: `Bearer ${CLIENT_TOKEN}`, ...(init.headers ?? {}) } });

// 1. 机器在线？
const machines = await (await api("/api/machines")).json();
if (!machines.find((m) => m.id === MACHINE_ID && m.online)) fail(`机器 ${MACHINE_ID} 不在线（daemon 装好了吗）`);
console.log("daemon 在线 ✓");

// 2. 客户端 WS：围观 + 自动批准权限
const ws = new WebSocket(`${HUB.replace(/^http/, "ws")}/ws/client`, {
  headers: { Authorization: `Bearer ${CLIENT_TOKEN}` },
});
await new Promise((ok, no) => { ws.once("open", ok); ws.once("error", no); });
ws.on("message", async (data) => {
  const m = JSON.parse(data.toString());
  if (m.kind === "event" && m.event.type === "permission_request" && m.event.conv === conv) {
    console.log(`收到权限请求：${m.event.body.description} → 自动批准`);
    await api("/api/permission-response", {
      method: "POST",
      body: JSON.stringify({ conv, request_id: m.event.body.request_id, choice: "allow" }),
    });
  }
  if (m.kind === "event" && m.event.conv === conv) console.log(`  [${m.event.type}]`, JSON.stringify(m.event.body).slice(0, 120));
});

// 3. 建会话
let conv = null;
const res = await api("/api/conversations", {
  method: "POST",
  body: JSON.stringify({
    machineId: MACHINE_ID,
    dir: "/tmp/pager-e2e",
    message: `在当前目录创建文件 ${MARKER}.txt，内容写 "hello from pager"，创建完就结束，不要做别的。`,
  }),
});
if (res.status !== 201) fail(`建会话 ${res.status}: ${await res.text()}`);
conv = (await res.json()).id;
console.log(`会话 ${conv} 已创建，等 Claude Code 干活…`);

// 4. 轮询 done（最多 5 分钟）
for (let i = 0; ; i++) {
  const list = await (await api("/api/conversations")).json();
  const row = list.find((c) => c.id === conv);
  if (row?.state === "done") break;
  if (row?.state === "failed") fail(`会话 failed: ${row.lastMessage}`);
  if (i > 150) fail(`5 分钟未完成（当前 ${row?.state}）`);
  await new Promise((r) => setTimeout(r, 2000));
}

// 5. 校验产物
if (!existsSync(FILE)) fail(`文件不存在: ${FILE}`);
console.log(`文件内容: ${readFileSync(FILE, "utf8").trim()}`);
rmSync(FILE, { force: true });
ws.close();
console.log("E2E PASS");
process.exit(0);
```

- [ ] **Step 4: 安装并跑 e2e**

Run:

```bash
bash daemon/deploy/install-launchd.sh
sleep 3 && tail -5 ~/.pager/logs/daemon.log   # 应看到 connected
set -a && source hub/.secrets.production.local && set +a
node daemon/scripts/e2e.mjs
```

Expected: `daemon 在线 ✓` → 会话创建 → （可能出现权限请求并自动批准）→ `E2E PASS`。失败先查 `~/.pager/logs/daemon.err.log`。

- [ ] **Step 5: Commit**

```bash
git add daemon
git commit -m "feat(daemon): 主入口、launchd 安装与生产端到端验收脚本"
```
