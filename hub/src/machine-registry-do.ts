import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.js";

// 全局单例：在线机器登记表。daemon 上下线时 MachineDO 上报到这，客户端建干活 bot 时列出可绑的机器。
export class MachineRegistryDO extends DurableObject<Env> {
  private sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS machines (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        dirs TEXT NOT NULL DEFAULT '[]',
        online INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      )`
    );
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/upsert") {
      const b = await req.json<{ id: string; name: string; dirs: string[]; online: boolean }>();
      this.sql.exec(
        `INSERT INTO machines (id, name, dirs, online, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, dirs = excluded.dirs, online = excluded.online, updated_at = excluded.updated_at`,
        b.id,
        b.name,
        JSON.stringify(b.dirs ?? []),
        b.online ? 1 : 0,
        Math.floor(Date.now() / 1000)
      );
      return Response.json({ ok: true });
    }
    if (req.method === "GET" && url.pathname === "/machines") {
      const rows = [...this.sql.exec("SELECT id, name, dirs, online FROM machines ORDER BY name")];
      return Response.json(
        rows.map((r) => ({ id: r.id, name: r.name, dirs: JSON.parse(r.dirs as string), online: r.online === 1 }))
      );
    }
    return new Response("not found", { status: 404 });
  }
}
