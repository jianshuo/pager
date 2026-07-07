import { DurableObject } from "cloudflare:workers";
import { ClientToHub } from "@pager/protocol";
import type { Env } from "./env.js";
import type { NotifyBody } from "./conversation-do.js";
import { pushPlanFor, sendApns, type ApnsConfig } from "./apns.js";

export class UserDO extends DurableObject<Env> {
  private sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        machineId TEXT NOT NULL,
        machineName TEXT NOT NULL,
        dir TEXT NOT NULL,
        state TEXT NOT NULL,
        lastMessage TEXT NOT NULL DEFAULT '',
        lastSeq INTEGER NOT NULL DEFAULT 0,
        updatedAt INTEGER NOT NULL
      )`
    );
    // kind: 'machine'（1:1 看机器，每条都发给 daemon）| 'room'（人对人房间，只有 @AI 才派给 daemon）
    try { this.sql.exec("ALTER TABLE conversations ADD COLUMN kind TEXT NOT NULL DEFAULT 'machine'"); } catch { /* 已存在 */ }
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS machines (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        online INTEGER NOT NULL,
        dirs TEXT NOT NULL,
        maxConcurrent INTEGER NOT NULL DEFAULT 1
      )`
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS devices (
        token TEXT PRIMARY KEY,
        updatedAt INTEGER NOT NULL
      )`
    );
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    switch (`${req.method} ${url.pathname}`) {
      case "GET /ws": {
        if (req.headers.get("Upgrade") !== "websocket")
          return new Response("expected websocket", { status: 426 });
        const pair = new WebSocketPair();
        this.ctx.acceptWebSocket(pair[1]);
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      case "POST /notify":
        return await this.notify((await req.json()) as NotifyBody);
      case "POST /notify-patch": {
        const p = await req.json<{ conv: string; eventId: string; markdown: string }>();
        this.broadcast({ kind: "patch", conv: p.conv, eventId: p.eventId, markdown: p.markdown });
        return Response.json({ ok: true });
      }
      case "POST /machine-status":
        return this.machineStatus(await req.json());
      case "POST /room": {
        // 人对人房间：machineName 存标题；可选绑定 machineId+dir 作为 AI 工作区（@AI 时派活）
        const r = await req.json<{ conv: string; title: string; machineId?: string; dir?: string }>();
        const now = Math.floor(Date.now() / 1000);
        this.sql.exec(
          `INSERT INTO conversations (id, machineId, machineName, dir, state, lastMessage, lastSeq, updatedAt, kind)
           VALUES (?, ?, ?, ?, 'idle', '', 0, ?, 'room')
           ON CONFLICT(id) DO UPDATE SET machineName = excluded.machineName, machineId = excluded.machineId, dir = excluded.dir, updatedAt = excluded.updatedAt`,
          r.conv,
          r.machineId ?? "",
          r.title,
          r.dir ?? "",
          now
        );
        return Response.json({ ok: true });
      }
      case "POST /register-device": {
        const { deviceToken } = await req.json<{ deviceToken: string }>();
        this.sql.exec(
          `INSERT INTO devices (token, updatedAt) VALUES (?, ?)
           ON CONFLICT(token) DO UPDATE SET updatedAt = excluded.updatedAt`,
          deviceToken,
          Math.floor(Date.now() / 1000)
        );
        return Response.json({ ok: true });
      }
      case "GET /conversations": {
        const rows = [...this.sql.exec("SELECT * FROM conversations ORDER BY updatedAt DESC")];
        return Response.json(rows);
      }
      case "GET /machines": {
        const rows = [...this.sql.exec("SELECT * FROM machines ORDER BY id")];
        return Response.json(
          rows.map((r) => ({
            id: r.id,
            name: r.name,
            online: r.online === 1,
            dirs: JSON.parse(r.dirs as string),
          }))
        );
      }
      default:
        return new Response("not found", { status: 404 });
    }
  }

  private async notify(body: NotifyBody): Promise<Response> {
    // lastMessage 可能为 null（status 事件不应覆盖上一条正文）：
    // INSERT 分支用 COALESCE(?, '') 满足 NOT NULL（全新会话首个事件就是 status 的边界情况）；
    // UPDATE 分支对同一个可能为 null 的绑定值再做一次 COALESCE，落到已存的旧值——
    // 注意不能写成 COALESCE(excluded.lastMessage, ...)：excluded 反映的是 VALUES 里表达式求值后的行，
    // 那时 COALESCE(?, '') 已经把 null 变成 ''，excluded.lastMessage 永远不是 null，UPDATE 分支就失效了。
    this.sql.exec(
      `INSERT INTO conversations (id, machineId, machineName, dir, state, lastMessage, lastSeq, updatedAt)
       VALUES (?, ?, ?, ?, ?, COALESCE(?, ''), ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         state = excluded.state,
         lastMessage = COALESCE(?, conversations.lastMessage),
         lastSeq = excluded.lastSeq,
         updatedAt = excluded.updatedAt`,
      body.conv,
      body.meta.machineId,
      body.meta.machineName,
      body.meta.dir,
      body.summary.state,
      body.summary.lastMessage,
      body.summary.lastSeq,
      body.summary.updatedAt,
      body.summary.lastMessage
    );
    this.broadcast({ kind: "event", event: body.event });
    if (this.ctx.getWebSockets().length === 0) await this.maybePush(body);
    return Response.json({ ok: true });
  }

  private async maybePush(body: NotifyBody): Promise<void> {
    const env = this.env;
    if (!env.APNS_TEAM_ID || !env.APNS_KEY_ID || !env.APNS_P8 || !env.APNS_BUNDLE_ID) return; // 未配置：静默跳过
    const plan = pushPlanFor(body.event, { machineName: body.meta.machineName });
    if (!plan) return;
    const cfg: ApnsConfig = {
      teamId: env.APNS_TEAM_ID,
      keyId: env.APNS_KEY_ID,
      p8Pem: env.APNS_P8,
      bundleId: env.APNS_BUNDLE_ID,
      env: env.APNS_ENV ?? "production",
    };
    const rows = [...this.sql.exec("SELECT token FROM devices")];
    for (const row of rows) {
      const payload: Record<string, unknown> = { conv: body.conv };
      if (plan.request_id) payload.request_id = plan.request_id;
      try {
        const r = await sendApns(cfg, {
          deviceToken: row.token as string,
          title: plan.title,
          body: plan.body,
          priority: plan.priority,
          category: plan.category,
          threadId: body.conv,
          payload,
        });
        if (r.gone) this.sql.exec("DELETE FROM devices WHERE token = ?", row.token);
      } catch {
        // 单台设备推送失败（网络/APNs 抖动）不该拖垮其它设备，也不能冒泡到 ingest 调用链
        continue;
      }
    }
  }

  private machineStatus(body: {
    machine: { id: string; name: string };
    online: boolean;
    dirs: string[];
    maxConcurrent: number;
  }): Response {
    this.sql.exec(
      `INSERT INTO machines (id, name, online, dirs, maxConcurrent)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, online = excluded.online,
         dirs = excluded.dirs, maxConcurrent = excluded.maxConcurrent`,
      body.machine.id,
      body.machine.name,
      body.online ? 1 : 0,
      JSON.stringify(body.dirs),
      body.maxConcurrent
    );
    this.broadcast({ kind: "machine_status", machine: body.machine, online: body.online });
    return Response.json({ ok: true });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (typeof data !== "string") return;
    let msg;
    try {
      msg = ClientToHub.parse(JSON.parse(data));
    } catch {
      return; // 非法消息丢弃
    }
    if (msg.kind === "subscribe") {
      const res = await this.conv(msg.conv).fetch(`https://do/events?after=${msg.afterSeq}`);
      const events = await res.json<unknown[]>();
      for (const event of events) {
        try {
          ws.send(JSON.stringify({ kind: "event", event }));
        } catch {
          break; // socket 已死，停止补 backlog
        }
      }
      return;
    }
    if (msg.kind === "send") {
      const row = [...this.sql.exec("SELECT machineId, dir, kind FROM conversations WHERE id = ?", msg.conv)][0];
      if (!row) return;
      const sealedRes = await this.conv(msg.conv).fetch("https://do/ingest", {
        method: "POST",
        body: JSON.stringify({ event: msg.event }),
      });
      if (!sealedRes.ok) return;
      const sealed = await sealedRes.json();
      const machineId = (row.machineId as string) ?? "";
      const kind = (row.kind as string) ?? "machine";
      const ev = msg.event as { type?: string; body?: { markdown?: string } };
      const text = ev.type === "text" && typeof ev.body?.markdown === "string" ? ev.body.markdown : "";

      if (kind === "room") {
        // 人对人房间：消息已 ingest+广播给所有人。只有 @百姓AI/@AI 且房间绑了机器时，
        // 才把这句话作为一个 task 派给 daemon——AI 在房间目录里干活，事件流回同一条时间线（3A）。
        if (machineId && mentionsAI(text)) {
          await this.env.MACHINE.get(this.env.MACHINE.idFromName(machineId)).fetch("https://do/deliver", {
            method: "POST",
            body: JSON.stringify({ kind: "task", conv: msg.conv, dir: row.dir as string, agent: "claude-code", event: sealed }),
          });
        }
      } else if (machineId) {
        // 机器会话：每条用户消息都转给 daemon（续聊）
        await this.env.MACHINE.get(this.env.MACHINE.idFromName(machineId)).fetch("https://do/deliver", {
          method: "POST",
          body: JSON.stringify({ kind: "user_event", conv: msg.conv, event: sealed }),
        });
      }
    }
  }

  async webSocketClose(): Promise<void> {
    // 客户端断连无需簿记：广播用 getWebSockets() 实时枚举
  }

  async webSocketError(): Promise<void> {
    // 同上；定义空处理器避免运行时对未定义 handler 报 TypeError
  }

  private broadcast(obj: unknown): void {
    const s = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(s);
      } catch {
        // 单个死 socket 不该拖垮其它客户端的广播
      }
    }
  }

  private conv(conv: string): DurableObjectStub {
    return this.env.CONVERSATION.get(this.env.CONVERSATION.idFromName(conv));
  }
}

// 是否 @ 了 AI（人对人房间里唤起百姓AI）
export function mentionsAI(text: string): boolean {
  return /@\s*(百姓\s*AI|AI|ai|Ai)\b/.test(text) || text.includes("@百姓AI") || text.includes("@AI");
}
