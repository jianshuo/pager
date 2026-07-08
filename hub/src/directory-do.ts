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
  }

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
      default:
        return new Response("not found", { status: 404 });
    }
  }

  private async register(body: { username: string; password: string }): Promise<Response> {
    const username = body.username;
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

  private mintSession(userId: string): string {
    const token = `stk_${crypto.randomUUID().replace(/-/g, "")}`;
    this.sql.exec("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)", token, userId, nowSec());
    return token;
  }
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
