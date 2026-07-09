import { DurableObject } from "cloudflare:workers";
import { EventDraftLoose, type EventLoose } from "@pager/protocol";
import { ZodError } from "zod";
import type { Env } from "./env.js";
import { streamBotReply, type ChatMsg } from "./responder.js";

// 一条会话（1:1 或群）：成员名单 + 消息流。发消息时按成员扇出到各自的 UserDO。
export interface ConvMeta {
  kind: "direct" | "group";
  title: string; // 群名；1:1 为空
  createdBy: string; // userId
}

export interface Member {
  userId: string;
  username: string;
  isBot?: boolean;
}

// 会话 → 每个成员 UserDO 的投递体。UserDO 据此更新会话索引、推送在线设备/APNs。
export interface NotifyBody {
  conv: string;
  event: EventLoose;
  summary: { lastMessage: string | null; lastSeq: number; updatedAt: number };
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
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS members (
        user_id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        joined_at INTEGER NOT NULL
      )`
    );
    // AI 成员标记：is_bot=1 的成员被叫到时走 bot 派发（不推手机）。
    try { this.sql.exec("ALTER TABLE members ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0"); } catch { /* 已存在 */ }
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const key = `${req.method} ${url.pathname}`;
    try {
      if (key === "POST /init") return await this.init(await req.json());
      if (key === "POST /ingest") return await this.ingest(await req.json());
      if (key === "POST /patch") return await this.patch(await req.json());
      if (key === "POST /members") return await this.addMember(await req.json());
      if (key === "GET /members") return this.listMembers();
      if (req.method === "DELETE" && url.pathname.startsWith("/members/"))
        return this.removeMember(decodeURIComponent(url.pathname.slice("/members/".length)));
      if (key === "GET /events") return this.events(Number(url.searchParams.get("after") ?? "0"));
      if (key === "GET /meta") return Response.json((await this.ctx.storage.get<ConvMeta>("meta")) ?? null);
      return new Response("not found", { status: 404 });
    } catch (err) {
      if (err instanceof ZodError) return Response.json({ error: err.issues }, { status: 400 });
      throw err;
    }
  }

  // 幂等：1:1 会话双方任一发起都会命中同一个 DO，已初始化则只补成员、不覆盖。
  private async init(body: {
    kind: "direct" | "group";
    title?: string;
    createdBy: string;
    members: Member[];
  }): Promise<Response> {
    const existing = await this.ctx.storage.get<ConvMeta>("meta");
    if (!existing) {
      const meta: ConvMeta = { kind: body.kind, title: body.title ?? "", createdBy: body.createdBy };
      await this.ctx.storage.put("meta", meta);
    }
    const now = nowSec();
    for (const m of body.members ?? []) {
      this.sql.exec(
        "INSERT OR IGNORE INTO members (user_id, username, joined_at, is_bot) VALUES (?, ?, ?, ?)",
        m.userId,
        m.username,
        now,
        m.isBot ? 1 : 0
      );
    }
    return Response.json((await this.ctx.storage.get<ConvMeta>("meta")) ?? null);
  }

  private async ingest(body: {
    event: unknown;
    senderUsername?: string;
    senderUserId?: string;
  }): Promise<Response> {
    // 成员校验：带 senderUserId 的消息（来自客户端 WS）必须是本会话成员，防非成员注入。
    // 不带 senderUserId 的（Worker 直接注入的 system 事件）跳过校验。
    if (body.senderUserId) {
      const member = [...this.sql.exec("SELECT 1 FROM members WHERE user_id = ?", body.senderUserId)][0];
      if (!member) return new Response("not a member", { status: 403 });
    }
    // seq 分配 + 落库必须在首个 await 之前同步完成，避免并发消息 seq 与到达顺序错位。
    const draft = EventDraftLoose.parse(body.event);
    const row = [...this.sql.exec("SELECT COALESCE(MAX(seq), 0) AS m FROM events")][0];
    const seq = (row.m as number) + 1;
    const event = { ...draft, seq } as EventLoose;
    // 服务端盖 author（防伪造）：文本消息用发送者已认证的 username 覆盖客户端自报值。
    if (event.type === "text" && body.senderUsername && event.body && typeof event.body === "object") {
      (event.body as Record<string, unknown>).author = body.senderUsername;
    }
    this.sql.exec("INSERT INTO events (seq, id, json) VALUES (?, ?, ?)", seq, event.id, JSON.stringify(event));

    await this.fanout({
      conv: event.conv,
      event,
      summary: { lastMessage: lastMessageOf(event), lastSeq: seq, updatedAt: event.ts },
    });

    // 人类 text 消息 → bot 派发（异步，不阻塞 ingest）。bot 自己的消息 role=agent，不触发（防死循环）。
    if (event.type === "text" && event.role === "user") {
      this.ctx.waitUntil(this.dispatchBots(event));
    }
    return Response.json(event);
  }

  // 找出本条消息"叫到"的 bot 成员：私信=唯一 bot；群=文本里 @<botUsername> 的 bot。逐个调后端回话。
  private async dispatchBots(event: EventLoose): Promise<void> {
    const meta = await this.ctx.storage.get<ConvMeta>("meta");
    const text = ((event.body as Record<string, unknown>)?.markdown as string) ?? "";
    const bots = [...this.sql.exec("SELECT user_id, username FROM members WHERE is_bot = 1")].map((r) => ({
      userId: r.user_id as string,
      username: r.username as string,
    }));
    const addressed =
      meta?.kind === "direct"
        ? bots
        : bots.filter((b) => new RegExp(`@${escapeRe(b.username)}\\b`, "i").test(text));
    for (const bot of addressed) {
      const d = await (await this.dir().fetch(`https://do/bot?userId=${bot.userId}`)).json<{
        backend: string;
        model: string;
      } | null>();
      if (!d || (d.backend !== "claude" && d.backend !== "chatgpt")) continue; // A 期只处理聊天 bot
      await this.hubRespond(event.conv, bot, d.backend, d.model);
    }
  }

  // 以 bot 身份先 ingest 一条空 text（拿 id），再拉最近历史调 LLM 流式、用 patch 覆盖。
  private async hubRespond(
    conv: string,
    bot: { userId: string; username: string },
    backend: "claude" | "chatgpt",
    model: string
  ): Promise<void> {
    const draft = {
      id: `evt_${crypto.randomUUID()}`,
      conv,
      ts: nowSec(),
      role: "agent",
      agent: "claude-code",
      type: "text",
      body: { markdown: "", author: bot.username },
    };
    const sealed = await (await this.ingest({ event: draft })).json<{ id: string }>();

    const history = [...this.sql.exec("SELECT json FROM events ORDER BY seq DESC LIMIT 31")]
      .map((r) => JSON.parse(r.json as string))
      .reverse()
      .filter((e) => e.type === "text" && e.id !== sealed.id);
    const messages: ChatMsg[] = history.map((e) => ({
      role: e.role === "agent" && e.body?.author === bot.username ? "assistant" : "user",
      content:
        e.role === "agent"
          ? (e.body?.markdown ?? "")
          : `${e.body?.author ?? "用户"}: ${e.body?.markdown ?? ""}`,
    }));
    const system = `你是 ${bot.username}，Mesh 里的一个 AI 成员，正在和用户对话。简洁、直接、有帮助地回复。`;

    let acc = "";
    try {
      for await (const delta of streamBotReply(this.env, backend, model, system, messages)) {
        acc += delta;
        await this.patch({ conv, eventId: sealed.id, markdown: acc });
      }
      if (!acc) await this.patch({ conv, eventId: sealed.id, markdown: "（无回复）" });
    } catch {
      await this.patch({ conv, eventId: sealed.id, markdown: `⚠️ ${bot.username} 出错了，稍后再试。` });
    }
  }

  private dir(): DurableObjectStub {
    return this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName("directory"));
  }

  private async patch(body: { conv: string; eventId: string; markdown: string }): Promise<Response> {
    const rows = [...this.sql.exec("SELECT json FROM events WHERE id = ?", body.eventId)];
    if (rows.length === 0) return new Response("unknown event", { status: 404 });
    const event = JSON.parse(rows[0].json as string);
    if (event.type !== "text") return new Response("not a text event", { status: 400 });
    event.body.markdown = body.markdown;
    this.sql.exec("UPDATE events SET json = ? WHERE id = ?", JSON.stringify(event), body.eventId);
    for (const m of this.members()) {
      await this.user(m.user_id as string).fetch("https://do/notify-patch", {
        method: "POST",
        body: JSON.stringify({ conv: body.conv, eventId: body.eventId, markdown: body.markdown }),
      });
    }
    return Response.json({ ok: true });
  }

  private async addMember(body: Member): Promise<Response> {
    const before = [...this.sql.exec("SELECT 1 FROM members WHERE user_id = ?", body.userId)][0];
    this.sql.exec(
      "INSERT OR IGNORE INTO members (user_id, username, joined_at, is_bot) VALUES (?, ?, ?, ?)",
      body.userId,
      body.username,
      nowSec(),
      body.isBot ? 1 : 0
    );
    return Response.json({ ok: true, added: !before });
  }

  private removeMember(userId: string): Response {
    this.sql.exec("DELETE FROM members WHERE user_id = ?", userId);
    return Response.json({ ok: true });
  }

  private listMembers(): Response {
    return Response.json(
      this.members().map((m) => ({ userId: m.user_id, username: m.username }))
    );
  }

  private events(after: number): Response {
    const rows = [...this.sql.exec("SELECT json FROM events WHERE seq > ? ORDER BY seq", after)];
    return Response.json(rows.map((r) => JSON.parse(r.json as string)));
  }

  private async fanout(notify: NotifyBody): Promise<void> {
    for (const m of this.members()) {
      await this.user(m.user_id as string).fetch("https://do/notify", {
        method: "POST",
        body: JSON.stringify(notify),
      });
    }
  }

  private members(): Record<string, unknown>[] {
    return [...this.sql.exec("SELECT user_id, username FROM members")];
  }

  private user(userId: string): DurableObjectStub {
    return this.env.USER.get(this.env.USER.idFromName(userId));
  }
}

function lastMessageOf(e: EventLoose): string | null {
  const b = e.body as Record<string, unknown> | undefined;
  if (e.type === "text" && typeof b?.markdown === "string") return b.markdown.slice(0, 120);
  if (e.type === "system" && typeof b?.text === "string") return b.text.slice(0, 120);
  if (e.type === "status") return null; // 状态变化不覆盖会话列表上一条正文
  return `[${e.type}]`;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
