import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.js";
import { hashPassword, verifyPassword } from "./crypto.js";

// 全局单例：用户名注册表 + session token。管注册、登录、鉴权（token→userId）、按用户名搜人。
// 用户名全局唯一，故必须集中在一个 DO 里查重/查找。
export class DirectoryDO extends DurableObject<Env> {
  private sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        pw_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`
    );
    // AI 成员：users.kind 区分 human/bot；bots 表存后端描述符。
    try { this.sql.exec("ALTER TABLE users ADD COLUMN kind TEXT NOT NULL DEFAULT 'human'"); } catch { /* 已存在 */ }
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS bots (
        user_id TEXT PRIMARY KEY,
        backend TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT '',
        owner_id TEXT NOT NULL DEFAULT '',
        machine_id TEXT NOT NULL DEFAULT '',
        dir TEXT NOT NULL DEFAULT ''
      )`
    );
    this.ensureBuiltinBots();
  }

  // 预置内置聊天 bot：Claude(Anthropic) + ChatGPT(OpenAI)。幂等，无密码不可登录。
  private ensureBuiltinBots(): void {
    const builtins = [
      { id: "usr_bot_claude", name: "claude", backend: "claude", model: "claude-opus-4-8" },
      { id: "usr_bot_chatgpt", name: "chatgpt", backend: "chatgpt", model: "gpt-5" },
    ];
    const now = nowSec();
    for (const b of builtins) {
      this.sql.exec(
        "INSERT OR IGNORE INTO users (user_id, username, pw_hash, created_at, kind) VALUES (?, ?, '', ?, 'bot')",
        b.id, b.name, now
      );
      this.sql.exec("INSERT OR IGNORE INTO bots (user_id, backend, model) VALUES (?, ?, ?)", b.id, b.backend, b.model);
    }
  }

  private static RESERVED = ["claude", "chatgpt"];

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    switch (`${req.method} ${url.pathname}`) {
      case "POST /register":
        return await this.register(await req.json());
      case "POST /login":
        return await this.login(await req.json());
      case "POST /resolve":
        return this.resolve(await req.json());
      case "POST /logout":
        return this.logout(await req.json());
      case "GET /search":
        return this.search(url.searchParams.get("q") ?? "");
      case "POST /names":
        return this.names(await req.json());
      case "POST /admin-delete-user":
        return this.adminDeleteUser(await req.json());
      case "POST /lookup":
        return this.lookup(await req.json());
      case "GET /bots":
        return this.listBots();
      case "GET /bot":
        return this.getBot(url.searchParams.get("userId") ?? "");
      case "POST /mint": {
        const { userId } = await req.json<{ userId: string }>();
        const exists = [...this.sql.exec("SELECT 1 FROM users WHERE user_id = ?", userId)][0];
        if (!exists) return Response.json(null);
        return Response.json({ token: this.mintSession(userId) });
      }
      default:
        return new Response("not found", { status: 404 });
    }
  }

  private async register(body: { username: string; password: string }): Promise<Response> {
    const username = body.username;
    if (DirectoryDO.RESERVED.includes(username))
      return Response.json({ error: "用户名被保留" }, { status: 409 });
    const exists = [...this.sql.exec("SELECT 1 FROM users WHERE username = ?", username)][0];
    if (exists) return Response.json({ error: "用户名已被占用" }, { status: 409 });
    const userId = `usr_${crypto.randomUUID()}`;
    const pwHash = await hashPassword(body.password);
    const now = nowSec();
    this.sql.exec(
      "INSERT INTO users (user_id, username, pw_hash, created_at) VALUES (?, ?, ?, ?)",
      userId,
      username,
      pwHash,
      now
    );
    const token = this.mintSession(userId);
    return Response.json({ userId, username, token });
  }

  private async login(body: { username: string; password: string }): Promise<Response> {
    const row = [...this.sql.exec("SELECT user_id, username, pw_hash FROM users WHERE username = ?", body.username)][0];
    if (!row || !(await verifyPassword(body.password, row.pw_hash as string)))
      return Response.json({ error: "用户名或密码不对" }, { status: 401 });
    const token = this.mintSession(row.user_id as string);
    return Response.json({ userId: row.user_id, username: row.username, token });
  }

  private resolve(body: { token: string }): Response {
    const row = [
      ...this.sql.exec(
        "SELECT u.user_id AS user_id, u.username AS username FROM sessions s JOIN users u ON u.user_id = s.user_id WHERE s.token = ?",
        body.token
      ),
    ][0];
    return row ? Response.json({ userId: row.user_id, username: row.username }) : Response.json(null);
  }

  private logout(body: { token: string }): Response {
    this.sql.exec("DELETE FROM sessions WHERE token = ?", body.token);
    return Response.json({ ok: true });
  }

  private search(q: string): Response {
    const prefix = q.trim().toLowerCase();
    if (!prefix) return Response.json([]);
    const rows = [
      ...this.sql.exec("SELECT user_id, username FROM users WHERE username LIKE ? || '%' ORDER BY username LIMIT 20", prefix),
    ];
    return Response.json(rows.map((r) => ({ userId: r.user_id, username: r.username })));
  }

  // 批量 userId → {userId, username, kind}，Worker 建群/建直连时补成员名 + 判断是否 bot。未知 id 跳过。
  private names(body: { userIds: string[] }): Response {
    const ids = Array.isArray(body.userIds) ? body.userIds : [];
    const out: { userId: string; username: string; kind: string }[] = [];
    for (const id of ids) {
      const row = [...this.sql.exec("SELECT username, kind FROM users WHERE user_id = ?", id)][0];
      if (row) out.push({ userId: id, username: row.username as string, kind: (row.kind as string) ?? "human" });
    }
    return Response.json(out);
  }

  // 内置聊天 bot 列表（Claude/ChatGPT）
  private listBots(): Response {
    const disp: Record<string, string> = { claude: "Claude", chatgpt: "ChatGPT" };
    const rows = [
      ...this.sql.exec(
        "SELECT u.user_id AS user_id, u.username AS username, b.backend AS backend FROM bots b JOIN users u ON u.user_id = b.user_id WHERE b.backend IN ('claude','chatgpt') ORDER BY u.username"
      ),
    ];
    return Response.json(
      rows.map((r) => ({ userId: r.user_id, username: r.username, backend: r.backend, displayName: disp[r.backend as string] ?? r.username }))
    );
  }

  // 单个 bot 的后端描述符（ConversationDO 派发时用）
  private getBot(userId: string): Response {
    const r = [...this.sql.exec("SELECT user_id, backend, model, owner_id, machine_id, dir FROM bots WHERE user_id = ?", userId)][0];
    return r
      ? Response.json({ userId: r.user_id, backend: r.backend, model: r.model, ownerId: r.owner_id, machineId: r.machine_id, dir: r.dir })
      : Response.json(null);
  }

  // 运维：按用户名删账号（释放用户名）。删 users + 其 sessions；旧 UserDO 实例作废不再被引用。
  private adminDeleteUser(body: { username: string }): Response {
    const username = (body.username ?? "").trim().toLowerCase();
    const row = [...this.sql.exec("SELECT user_id FROM users WHERE username = ?", username)][0];
    if (!row) return Response.json({ ok: true, deleted: false });
    this.sql.exec("DELETE FROM sessions WHERE user_id = ?", row.user_id);
    this.sql.exec("DELETE FROM users WHERE username = ?", username);
    return Response.json({ ok: true, deleted: true, userId: row.user_id });
  }

  // 精确按用户名查 userId + kind（诊断/建会话判 bot 用）
  private lookup(body: { username: string }): Response {
    const username = (body.username ?? "").trim().toLowerCase();
    const row = [...this.sql.exec("SELECT user_id, username, kind FROM users WHERE username = ?", username)][0];
    return row
      ? Response.json({ userId: row.user_id, username: row.username, kind: (row.kind as string) ?? "human" })
      : Response.json(null);
  }

  private mintSession(userId: string): string {
    const token = `stk_${crypto.randomUUID().replace(/-/g, "")}`;
    this.sql.exec("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)", token, userId, nowSec());
    return token;
  }
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
