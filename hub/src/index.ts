import type { Env } from "./env.js";
import { ConversationDO } from "./conversation-do.js";
import { MachineDO } from "./machine-do.js";
import { UserDO } from "./user-do.js";
import {
  NewConversationRequest,
  NewConversationResponse,
  PermissionResponseRequest,
  DeviceRegistration,
  newId,
  type EventDraft,
} from "@pager/protocol";
import { ZodError } from "zod";

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

    try {
      if (url.pathname === "/api/machines" && req.method === "GET")
        return user(env).fetch("https://do/machines");
      if (url.pathname === "/api/conversations" && req.method === "GET")
        return user(env).fetch("https://do/conversations");
      if (url.pathname === "/api/conversations" && req.method === "POST")
        return await newConversation(env, await req.json());
      if (url.pathname === "/api/rooms" && req.method === "POST")
        return await newRoom(env, await req.json());
      if (url.pathname === "/api/permission-response" && req.method === "POST")
        return await permissionResponse(env, await req.json());
      if (url.pathname === "/api/register-device" && req.method === "POST") {
        const body = DeviceRegistration.parse(await req.json());
        return user(env).fetch("https://do/register-device", {
          method: "POST",
          body: JSON.stringify(body),
        });
      }
    } catch (err) {
      if (err instanceof ZodError) return Response.json({ error: err.issues }, { status: 400 });
      if (err instanceof SyntaxError) return Response.json({ error: "malformed json" }, { status: 400 });
      throw err;
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

async function newConversation(env: Env, raw: unknown): Promise<Response> {
  const body = NewConversationRequest.parse(raw);
  const machine = env.MACHINE.get(env.MACHINE.idFromName(body.machineId));
  const info = await (await machine.fetch("https://do/info")).json<{
    machine: { id: string; name: string };
    dirs: string[];
    online: boolean;
  } | null>();
  if (!info?.online) return Response.json({ error: "machine offline" }, { status: 409 });
  if (!info.dirs.includes(body.dir)) return Response.json({ error: "dir not allowed" }, { status: 400 });

  const conv = newId("cnv");
  const convStub = env.CONVERSATION.get(env.CONVERSATION.idFromName(conv));
  const initRes = await convStub.fetch("https://do/init", {
    method: "POST",
    body: JSON.stringify({ machineId: body.machineId, machineName: info.machine.name, dir: body.dir }),
  });
  if (!initRes.ok) return Response.json({ error: "failed to initialize conversation" }, { status: 500 });

  const draft: EventDraft = {
    id: newId("evt"),
    conv,
    ts: nowSec(),
    role: "user",
    agent: "claude-code",
    type: "text",
    body: { markdown: body.message },
  };
  const ingestRes = await convStub.fetch("https://do/ingest", {
    method: "POST",
    body: JSON.stringify({ event: draft }),
  });
  if (!ingestRes.ok) return Response.json({ error: "failed to ingest task message" }, { status: 500 });
  const sealed = await ingestRes.json();

  const deliverRes = await machine.fetch("https://do/deliver", {
    method: "POST",
    body: JSON.stringify({ kind: "task", conv, dir: body.dir, agent: "claude-code", event: sealed }),
  });
  const { delivered } = await deliverRes.json<{ delivered: boolean }>();
  if (!delivered) {
    const failDraft: EventDraft = {
      id: newId("evt"),
      conv,
      ts: nowSec(),
      role: "system",
      agent: "claude-code",
      type: "status",
      body: { state: "failed", note: "daemon 掉线，任务未送达" },
    };
    await convStub.fetch("https://do/ingest", { method: "POST", body: JSON.stringify({ event: failDraft }) });
    return Response.json({ error: "daemon went offline" }, { status: 502 });
  }
  return Response.json(NewConversationResponse.parse({ id: conv }), { status: 201 });
}

// 人对人聊天房间：一个没有机器/daemon 的会话。两个人订阅同一个 conv、互发 text，
// 靠 UserDO 广播互相看到。machineName 复用为房间标题。
async function newRoom(env: Env, raw: unknown): Promise<Response> {
  const r = (raw ?? {}) as { title?: unknown; machineId?: unknown; dir?: unknown };
  const title = typeof r.title === "string" ? r.title.trim() : "";
  if (!title) return Response.json({ error: "title required" }, { status: 400 });
  // 可选绑定一台机器 + 目录作为房间的 AI 工作区（@百姓AI 时派活）
  const machineId = typeof r.machineId === "string" ? r.machineId : "";
  const dir = typeof r.dir === "string" ? r.dir : "";
  const conv = newId("cnv");
  const convStub = env.CONVERSATION.get(env.CONVERSATION.idFromName(conv));
  const initRes = await convStub.fetch("https://do/init", {
    method: "POST",
    body: JSON.stringify({ machineId, machineName: title, dir }),
  });
  if (!initRes.ok) return Response.json({ error: "failed to create room" }, { status: 500 });
  // 立刻登记进会话索引（kind='room' + 绑定），无消息也能出现在列表
  await user(env).fetch("https://do/room", {
    method: "POST",
    body: JSON.stringify({ conv, title, machineId, dir }),
  });
  return Response.json({ id: conv }, { status: 201 });
}

async function permissionResponse(env: Env, raw: unknown): Promise<Response> {
  const body = PermissionResponseRequest.parse(raw);
  const convStub = env.CONVERSATION.get(env.CONVERSATION.idFromName(body.conv));
  const meta = await (await convStub.fetch("https://do/meta")).json<{ machineId: string } | null>();
  if (!meta) return Response.json({ error: "unknown conversation" }, { status: 404 });

  const draft: EventDraft = {
    id: newId("evt"),
    conv: body.conv,
    ts: nowSec(),
    role: "user",
    agent: "claude-code",
    type: "permission_response",
    body: { request_id: body.request_id, choice: body.choice },
  };
  const ingestRes = await convStub.fetch("https://do/ingest", {
    method: "POST",
    body: JSON.stringify({ event: draft }),
  });
  if (!ingestRes.ok) return Response.json({ error: "failed to ingest permission response" }, { status: 500 });
  const sealed = await ingestRes.json();

  const deliverRes = await env.MACHINE.get(env.MACHINE.idFromName(meta.machineId)).fetch("https://do/deliver", {
    method: "POST",
    body: JSON.stringify({ kind: "user_event", conv: body.conv, event: sealed }),
  });
  const { delivered } = await deliverRes.json<{ delivered: boolean }>();
  // daemon 掉线的兜底是它自身的超时拒绝逻辑，这里不再补状态事件
  if (!delivered) return Response.json({ error: "daemon offline" }, { status: 502 });
  return Response.json({ ok: true });
}
