import { DurableObject } from "cloudflare:workers";
import { ClientToHub } from "@pager/protocol";
import type { Env } from "./env.js";
import type { NotifyBody } from "./conversation-do.js";

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
    this.sql.exec(
      `INSERT INTO conversations (id, machineId, machineName, dir, state, lastMessage, lastSeq, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         state = excluded.state,
         lastMessage = excluded.lastMessage,
         lastSeq = excluded.lastSeq,
         updatedAt = excluded.updatedAt`,
      body.conv,
      body.meta.machineId,
      body.meta.machineName,
      body.meta.dir,
      body.summary.state,
      body.summary.lastMessage,
      body.summary.lastSeq,
      body.summary.updatedAt
    );
    this.broadcast({ kind: "event", event: body.event });
    // Task 6 在这里追加：无客户端在线时按规则 APNs
    return Response.json({ ok: true });
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
      for (const event of events) ws.send(JSON.stringify({ kind: "event", event }));
      return;
    }
    if (msg.kind === "send") {
      const row = [...this.sql.exec("SELECT machineId FROM conversations WHERE id = ?", msg.conv)][0];
      if (!row) return;
      const sealedRes = await this.conv(msg.conv).fetch("https://do/ingest", {
        method: "POST",
        body: JSON.stringify({ event: msg.event }),
      });
      if (!sealedRes.ok) return;
      const sealed = await sealedRes.json();
      await this.env.MACHINE.get(this.env.MACHINE.idFromName(row.machineId as string)).fetch(
        "https://do/deliver",
        { method: "POST", body: JSON.stringify({ kind: "user_event", conv: msg.conv, event: sealed }) }
      );
    }
  }

  private broadcast(obj: unknown): void {
    const s = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) ws.send(s);
  }

  private conv(conv: string): DurableObjectStub {
    return this.env.CONVERSATION.get(this.env.CONVERSATION.idFromName(conv));
  }
}
