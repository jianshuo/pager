import type { Env } from "./env.js";
import { ConversationDO } from "./conversation-do.js";
import { MachineDO } from "./machine-do.js";
import { UserDO } from "./user-do.js";

export { ConversationDO, MachineDO, UserDO };

function bearer(req: Request): string | null {
  const h = req.headers.get("Authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

export function user(env: Env): DurableObjectStub {
  return env.USER.get(env.USER.idFromName("user"));
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return Response.json({ ok: true });

    const token = bearer(req);

    if (url.pathname === "/ws/daemon") {
      if (token !== env.DAEMON_TOKEN) return new Response("unauthorized", { status: 401 });
      const machineId = url.searchParams.get("machine");
      if (!machineId?.startsWith("mch_")) return new Response("bad machine id", { status: 400 });
      return env.MACHINE.get(env.MACHINE.idFromName(machineId)).fetch(new Request("https://do/ws", req));
    }

    if (token !== env.CLIENT_TOKEN) return new Response("unauthorized", { status: 401 });

    if (url.pathname === "/ws/client") {
      return user(env).fetch(new Request("https://do/ws", req));
    }

    // REST 路由在 Task 5 补充
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
