import { DurableObject } from "cloudflare:workers";
import { EventDraftLoose, StatusBody, type EventLoose } from "@pager/protocol";
import { ZodError } from "zod";
import type { Env } from "./env.js";

export interface ConvMeta {
  machineId: string;
  machineName: string;
  dir: string;
  agentSessionId?: string;
  state: string;
}

export interface NotifyBody {
  conv: string;
  event: EventLoose;
  meta: ConvMeta;
  // status 事件不代表一条可展示的正文：lastMessage 为 null 时，UserDO 保留会话列表里上一条的值
  summary: { state: string; lastMessage: string | null; lastSeq: number; updatedAt: number };
}

export class ConversationDO extends DurableObject<Env> {
  private sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY,
        id TEXT UNIQUE NOT NULL,
        json TEXT NOT NULL
      )`
    );
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    try {
      switch (`${req.method} ${url.pathname}`) {
        case "POST /init":
          return await this.init(await req.json());
        case "POST /ingest":
          // return await（而非 return）：否则 promise rejection 会绕过本层 catch，ZodError 变 500
          return await this.ingest(await req.json());
        case "POST /patch":
          return await this.patch(await req.json());
        case "POST /session":
          return await this.session(await req.json());
        case "GET /events":
          return this.events(Number(url.searchParams.get("after") ?? "0"));
        case "GET /meta":
          return Response.json((await this.ctx.storage.get<ConvMeta>("meta")) ?? null);
        default:
          return new Response("not found", { status: 404 });
      }
    } catch (err) {
      if (err instanceof ZodError) return Response.json({ error: err.issues }, { status: 400 });
      throw err;
    }
  }

  private async init(body: { machineId: string; machineName: string; dir: string }): Promise<Response> {
    const meta: ConvMeta = {
      machineId: body.machineId,
      machineName: body.machineName,
      dir: body.dir,
      state: "thinking",
    };
    await this.ctx.storage.put("meta", meta);
    return Response.json(meta);
  }

  private async ingest(body: { event: unknown }): Promise<Response> {
    // 注意：解析 + seq 计算 + 落库必须在第一个 await 之前同步跑完——
    // 一旦在这之前插入 await，多条并发到达的 daemon 事件（同一个 conv）就可能在这里交错，
    // seq 分配顺序不再保证跟到达顺序一致（曾实测触发：running/done 两条 status 乱序落到 UserDO）。
    const draft = EventDraftLoose.parse(body.event);
    const row = [...this.sql.exec("SELECT COALESCE(MAX(seq), 0) AS m FROM events")][0];
    const seq = (row.m as number) + 1;
    const event = { ...draft, seq } as EventLoose;
    this.sql.exec("INSERT INTO events (seq, id, json) VALUES (?, ?, ?)", seq, event.id, JSON.stringify(event));

    const meta = await this.ctx.storage.get<ConvMeta>("meta");
    if (!meta) return Response.json({ error: "conversation not initialized" }, { status: 409 });

    if (event.type === "status") {
      const s = StatusBody.safeParse(event.body);
      if (s.success) {
        meta.state = s.data.state;
        await this.ctx.storage.put("meta", meta);
      }
    }

    const notify: NotifyBody = {
      conv: event.conv,
      event,
      meta,
      summary: {
        state: meta.state,
        lastMessage: lastMessageOf(event),
        lastSeq: seq,
        updatedAt: event.ts,
      },
    };
    await this.user().fetch("https://do/notify", { method: "POST", body: JSON.stringify(notify) });
    return Response.json(event);
  }

  private async patch(body: { conv: string; eventId: string; markdown: string }): Promise<Response> {
    const rows = [...this.sql.exec("SELECT json FROM events WHERE id = ?", body.eventId)];
    if (rows.length === 0) return new Response("unknown event", { status: 404 });
    const event = JSON.parse(rows[0].json as string);
    if (event.type !== "text") return new Response("not a text event", { status: 400 });
    event.body.markdown = body.markdown;
    this.sql.exec("UPDATE events SET json = ? WHERE id = ?", JSON.stringify(event), body.eventId);
    await this.user().fetch("https://do/notify-patch", {
      method: "POST",
      body: JSON.stringify({ conv: body.conv, eventId: body.eventId, markdown: body.markdown }),
    });
    return Response.json({ ok: true });
  }

  private async session(body: { agentSessionId: string }): Promise<Response> {
    const meta = await this.ctx.storage.get<ConvMeta>("meta");
    if (!meta) return new Response("no meta", { status: 404 });
    meta.agentSessionId = body.agentSessionId;
    await this.ctx.storage.put("meta", meta);
    return Response.json({ ok: true });
  }

  private events(after: number): Response {
    const rows = [...this.sql.exec("SELECT json FROM events WHERE seq > ? ORDER BY seq", after)];
    return Response.json(rows.map((r) => JSON.parse(r.json as string)));
  }

  private user(): DurableObjectStub {
    return this.env.USER.get(this.env.USER.idFromName("user"));
  }
}

function lastMessageOf(e: EventLoose): string | null {
  const b = e.body as Record<string, unknown> | undefined;
  if (e.type === "text" && typeof b?.markdown === "string") return b.markdown.slice(0, 120);
  if (e.type === "tool_card" && typeof b?.title === "string") return b.title.slice(0, 120);
  if (e.type === "permission_request" && typeof b?.description === "string")
    return `需要批准：${b.description}`.slice(0, 120);
  // status 事件只是状态变化，不是一条新正文：不覆盖会话列表里上一条的 lastMessage
  if (e.type === "status") return null;
  return `[${e.type}]`;
}
