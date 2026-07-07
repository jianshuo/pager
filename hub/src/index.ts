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
  await convStub.fetch("https://do/init", {
    method: "POST",
    body: JSON.stringify({ machineId: body.machineId, machineName: info.machine.name, dir: body.dir }),
  });
  const draft: EventDraft = {
    id: newId("evt"),
    conv,
    ts: nowSec(),
    role: "user",
    agent: "claude-code",
    type: "text",
    body: { markdown: body.message },
  };
  const sealed = await (
    await convStub.fetch("https://do/ingest", { method: "POST", body: JSON.stringify({ event: draft }) })
  ).json();
  await machine.fetch("https://do/deliver", {
    method: "POST",
    body: JSON.stringify({ kind: "task", conv, dir: body.dir, agent: "claude-code", event: sealed }),
  });
  return Response.json(NewConversationResponse.parse({ id: conv }), { status: 201 });
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
  const sealed = await (
    await convStub.fetch("https://do/ingest", { method: "POST", body: JSON.stringify({ event: draft }) })
  ).json();
  await env.MACHINE.get(env.MACHINE.idFromName(meta.machineId)).fetch("https://do/deliver", {
    method: "POST",
    body: JSON.stringify({ kind: "user_event", conv: body.conv, event: sealed }),
  });
  return Response.json({ ok: true });
}
