import { DurableObject } from "cloudflare:workers";
import { ClientToHub } from "@pager/protocol";
import type { Env } from "./env.js";
import type { NotifyBody } from "./conversation-do.js";
import { pushPlanFor, sendApns, type ApnsConfig } from "./apns.js";

// 每个用户一个实例（idFromName(userId)）：好友、会话索引、设备、该用户所有设备的 WS 扇出。
export class UserDO extends DurableObject<Env> {
  private sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS friends (
        friend_user_id TEXT PRIMARY KEY,
        friend_username TEXT NOT NULL,
        added_at INTEGER NOT NULL
      )`
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        peer_user_id TEXT NOT NULL DEFAULT '',
        peer_username TEXT NOT NULL DEFAULT '',
        last_seq INTEGER NOT NULL DEFAULT 0,
        last_message TEXT NOT NULL DEFAULT '',
        last_ts INTEGER NOT NULL DEFAULT 0
      )`
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS devices (
        token TEXT PRIMARY KEY,
        updated_at INTEGER NOT NULL
      )`
    );
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const key = `${req.method} ${url.pathname}`;
    if (key === "GET /ws") {
      if (req.headers.get("Upgrade") !== "websocket")
        return new Response("expected websocket", { status: 426 });
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      // Worker 已鉴权，用 ?user=&name= 传身份；挂 socket 上（跨休眠保留），send 时盖 author。
      const userId = url.searchParams.get("user") ?? "";
      const username = url.searchParams.get("name") ?? "";
      pair[1].serializeAttachment({ userId, username });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (key === "POST /friends") {
      const b = await req.json<{ userId: string; username: string }>();
      this.sql.exec(
        "INSERT OR IGNORE INTO friends (friend_user_id, friend_username, added_at) VALUES (?, ?, ?)",
        b.userId,
        b.username,
        nowSec()
      );
      return Response.json({ ok: true });
    }
    if (key === "GET /friends") {
      const rows = [...this.sql.exec("SELECT friend_user_id, friend_username FROM friends ORDER BY added_at DESC")];
      return Response.json(rows.map((r) => ({ userId: r.friend_user_id, username: r.friend_username })));
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/friends/")) {
      const id = decodeURIComponent(url.pathname.slice("/friends/".length));
      this.sql.exec("DELETE FROM friends WHERE friend_user_id = ?", id);
      return Response.json({ ok: true });
    }
    if (key === "POST /index-conv") {
      const b = await req.json<{
        conv: string;
        kind: string;
        title?: string;
        peerUserId?: string;
        peerUsername?: string;
      }>();
      this.sql.exec(
        `INSERT INTO conversations (id, kind, title, peer_user_id, peer_username, last_ts)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title, peer_user_id = excluded.peer_user_id, peer_username = excluded.peer_username`,
        b.conv,
        b.kind,
        b.title ?? "",
        b.peerUserId ?? "",
        b.peerUsername ?? "",
        nowSec()
      );
      return Response.json({ ok: true });
    }
    if (key === "GET /conversations") {
      const rows = [...this.sql.exec("SELECT * FROM conversations ORDER BY last_ts DESC")];
      return Response.json(
        rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          title: r.title,
          peerUserId: r.peer_user_id,
          peerUsername: r.peer_username,
          lastMessage: r.last_message,
          lastSeq: r.last_seq,
          updatedAt: r.last_ts,
        }))
      );
    }
    if (key === "POST /register-device") {
      const { deviceToken } = await req.json<{ deviceToken: string }>();
      this.sql.exec(
        "INSERT INTO devices (token, updated_at) VALUES (?, ?) ON CONFLICT(token) DO UPDATE SET updated_at = excluded.updated_at",
        deviceToken,
        nowSec()
      );
      return Response.json({ ok: true });
    }
    if (key === "POST /notify") return await this.notify(await req.json());
    if (key === "POST /notify-patch") {
      const p = await req.json<{ conv: string; eventId: string; markdown: string }>();
      this.broadcast({ kind: "patch", conv: p.conv, eventId: p.eventId, markdown: p.markdown });
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  }

  private async notify(body: NotifyBody): Promise<Response> {
    // status 事件 lastMessage 为 null：只更 seq/ts，不覆盖会话列表上一条正文。
    this.sql.exec(
      `UPDATE conversations SET
         last_message = COALESCE(?, last_message),
         last_seq = ?, last_ts = ?
       WHERE id = ?`,
      body.summary.lastMessage,
      body.summary.lastSeq,
      body.summary.updatedAt,
      body.conv
    );
    this.broadcast({ kind: "event", event: body.event });
    if (this.ctx.getWebSockets().length === 0) await this.maybePush(body);
    return Response.json({ ok: true });
  }

  private async maybePush(body: NotifyBody): Promise<void> {
    const env = this.env;
    if (!env.APNS_TEAM_ID || !env.APNS_KEY_ID || !env.APNS_P8 || !env.APNS_BUNDLE_ID) return;
    const row = [...this.sql.exec("SELECT kind, title FROM conversations WHERE id = ?", body.conv)][0];
    // 群显示群名；1:1 显示发送者名（消息 author）
    const authorName =
      (body.event.body as Record<string, unknown> | undefined)?.author;
    const title =
      row?.kind === "group" ? (row.title as string) : typeof authorName === "string" ? authorName : "";
    const plan = pushPlanFor(body.event, { title });
    if (!plan) return;
    const cfg: ApnsConfig = {
      teamId: env.APNS_TEAM_ID,
      keyId: env.APNS_KEY_ID,
      p8Pem: env.APNS_P8,
      bundleId: env.APNS_BUNDLE_ID,
      env: env.APNS_ENV ?? "production",
    };
    const devices = [...this.sql.exec("SELECT token FROM devices")];
    for (const d of devices) {
      try {
        const r = await sendApns(cfg, {
          deviceToken: d.token as string,
          title: plan.title,
          body: plan.body,
          priority: plan.priority,
          threadId: body.conv,
          payload: { conv: body.conv },
        });
        if (r.gone) this.sql.exec("DELETE FROM devices WHERE token = ?", d.token);
      } catch {
        continue;
      }
    }
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (typeof data !== "string") return;
    let msg;
    try {
      msg = ClientToHub.parse(JSON.parse(data));
    } catch {
      return;
    }
    if (msg.kind === "subscribe") {
      const res = await this.conv(msg.conv).fetch(`https://do/events?after=${msg.afterSeq}`);
      const events = await res.json<unknown[]>();
      for (const event of events) {
        try {
          ws.send(JSON.stringify({ kind: "event", event }));
        } catch {
          break;
        }
      }
      return;
    }
    if (msg.kind === "send") {
      // 交给 ConversationDO 盖 seq + 盖 author + 按成员扇出（含扇回本用户 → 广播多设备）。
      const att = ws.deserializeAttachment() as { userId?: string; username?: string } | null;
      await this.conv(msg.conv).fetch("https://do/ingest", {
        method: "POST",
        body: JSON.stringify({ event: msg.event, senderUsername: att?.username }),
      });
    }
  }

  async webSocketClose(): Promise<void> {}
  async webSocketError(): Promise<void> {}

  private broadcast(obj: unknown): void {
    const s = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(s);
      } catch {
        // 单个死 socket 不拖垮其它设备
      }
    }
  }

  private conv(conv: string): DurableObjectStub {
    return this.env.CONVERSATION.get(this.env.CONVERSATION.idFromName(conv));
  }
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
