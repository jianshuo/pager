import type { Env } from "./env.js";
import { ConversationDO } from "./conversation-do.js";
import { MachineDO } from "./machine-do.js";
import { UserDO } from "./user-do.js";
import { DirectoryDO } from "./directory-do.js";
import {
  RegisterRequest,
  LoginRequest,
  AddFriendRequest,
  DirectConversationRequest,
  NewGroupRequest,
  AddMemberRequest,
  DeviceRegistration,
  newId,
} from "@pager/protocol";
import { ZodError } from "zod";

// MachineDO 仍绑定但不再路由（Pager 遗留，待后续 deleted_classes 迁移清理）
export { ConversationDO, MachineDO, UserDO, DirectoryDO };

function bearer(req: Request): string | null {
  const h = req.headers.get("Authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

function directory(env: Env): DurableObjectStub {
  return env.DIRECTORY.get(env.DIRECTORY.idFromName("directory"));
}
function userStub(env: Env, userId: string): DurableObjectStub {
  return env.USER.get(env.USER.idFromName(userId));
}
function convStub(env: Env, conv: string): DurableObjectStub {
  return env.CONVERSATION.get(env.CONVERSATION.idFromName(conv));
}

interface Identity {
  userId: string;
  username: string;
}

async function resolveSession(env: Env, token: string | null): Promise<Identity | null> {
  if (!token) return null;
  const who = await (
    await directory(env).fetch("https://do/resolve", { method: "POST", body: JSON.stringify({ token }) })
  ).json<Identity | null>();
  return who;
}

// 批量把 userId 解析成 username（未知 id 被跳过）
async function resolveNames(env: Env, ids: string[]): Promise<Map<string, string>> {
  const rows = await (
    await directory(env).fetch("https://do/names", { method: "POST", body: JSON.stringify({ userIds: ids }) })
  ).json<{ userId: string; username: string }[]>();
  return new Map(rows.map((r) => [r.userId, r.username]));
}

async function jsonBody<T>(req: Request): Promise<T> {
  return (await req.json()) as T;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === "/health") return Response.json({ ok: true });

    const token = bearer(req);

    // 公开：注册 / 登录
    try {
      if (path === "/api/register" && req.method === "POST")
        return directory(env).fetch("https://do/register", {
          method: "POST",
          body: JSON.stringify(RegisterRequest.parse(await req.json())),
        });
      if (path === "/api/login" && req.method === "POST")
        return directory(env).fetch("https://do/login", {
          method: "POST",
          body: JSON.stringify(LoginRequest.parse(await req.json())),
        });
    } catch (err) {
      if (err instanceof ZodError) return Response.json({ error: err.issues }, { status: 400 });
      if (err instanceof SyntaxError) return Response.json({ error: "malformed json" }, { status: 400 });
      throw err;
    }

    // 运维：按用户名删账号，用工作区密钥 CLIENT_TOKEN 保护（非 session）。释放被占用的用户名。
    if (path.startsWith("/api/admin/users/") && req.method === "DELETE") {
      if (!token || token !== env.CLIENT_TOKEN) return new Response("unauthorized", { status: 401 });
      const username = decodeURIComponent(path.slice("/api/admin/users/".length));
      return directory(env).fetch("https://do/admin-delete-user", {
        method: "POST",
        body: JSON.stringify({ username }),
      });
    }

    // 运维/诊断：读某用户的真实状态（userId/好友/会话），用 CLIENT_TOKEN 保护。
    if (path === "/api/admin/inspect" && req.method === "GET") {
      if (!token || token !== env.CLIENT_TOKEN) return new Response("unauthorized", { status: 401 });
      const username = url.searchParams.get("username") ?? "";
      const who = await (
        await directory(env).fetch("https://do/lookup", { method: "POST", body: JSON.stringify({ username }) })
      ).json<{ userId: string; username: string } | null>();
      if (!who) return Response.json({ error: "no such user", username }, { status: 404 });
      const friends = await (await userStub(env, who.userId).fetch("https://do/friends")).json();
      const conversations = await (await userStub(env, who.userId).fetch("https://do/conversations")).json();
      return Response.json({ userId: who.userId, username: who.username, friends, conversations });
    }
    // 运维：为某用户名铸一个 session token（修数据/诊断用，CLIENT_TOKEN 保护）。
    if (path === "/api/admin/mint-session" && req.method === "POST") {
      if (!token || token !== env.CLIENT_TOKEN) return new Response("unauthorized", { status: 401 });
      const { username } = await req.json<{ username: string }>();
      const who = await (
        await directory(env).fetch("https://do/lookup", { method: "POST", body: JSON.stringify({ username }) })
      ).json<{ userId: string; username: string } | null>();
      if (!who) return Response.json({ error: "no such user" }, { status: 404 });
      const minted = await (
        await directory(env).fetch("https://do/mint", { method: "POST", body: JSON.stringify({ userId: who.userId }) })
      ).json();
      return Response.json({ userId: who.userId, username: who.username, ...(minted as object) });
    }
    // 诊断：读某会话的成员名单
    if (path.startsWith("/api/admin/conv-members/") && req.method === "GET") {
      if (!token || token !== env.CLIENT_TOKEN) return new Response("unauthorized", { status: 401 });
      const conv = decodeURIComponent(path.slice("/api/admin/conv-members/".length));
      const members = await (await convStub(env, conv).fetch("https://do/members")).json();
      const meta = await (await convStub(env, conv).fetch("https://do/meta")).json();
      return Response.json({ conv, meta, members });
    }

    // 其余全部需要有效 session
    const me = await resolveSession(env, token);
    if (!me) return new Response("unauthorized", { status: 401 });

    // WebSocket：把身份带进 UserDO
    if (path === "/ws/client") {
      const wsUrl = new URL("https://do/ws");
      wsUrl.searchParams.set("user", me.userId);
      wsUrl.searchParams.set("name", me.username);
      return userStub(env, me.userId).fetch(new Request(wsUrl.toString(), req));
    }

    try {
      if (path === "/api/me" && req.method === "GET")
        return Response.json({ userId: me.userId, username: me.username });

      if (path === "/api/logout" && req.method === "POST")
        return directory(env).fetch("https://do/logout", { method: "POST", body: JSON.stringify({ token }) });

      if (path === "/api/users" && req.method === "GET")
        return directory(env).fetch(`https://do/search?q=${encodeURIComponent(url.searchParams.get("q") ?? "")}`);

      if (path === "/api/friends" && req.method === "GET")
        return userStub(env, me.userId).fetch("https://do/friends");

      if (path === "/api/friends" && req.method === "POST")
        return await addFriend(env, me, AddFriendRequest.parse(await req.json()));

      if (path.startsWith("/api/friends/") && req.method === "DELETE") {
        const id = decodeURIComponent(path.slice("/api/friends/".length));
        return userStub(env, me.userId).fetch(`https://do/friends/${encodeURIComponent(id)}`, { method: "DELETE" });
      }

      if (path === "/api/conversations" && req.method === "GET")
        return userStub(env, me.userId).fetch("https://do/conversations");

      if (path === "/api/conversations/direct" && req.method === "POST")
        return await directConversation(env, me, DirectConversationRequest.parse(await req.json()));

      if (path === "/api/groups" && req.method === "POST")
        return await newGroup(env, me, NewGroupRequest.parse(await req.json()));

      // /api/conversations/:id/members  (POST 拉人)  /members/me (DELETE 退群)
      const memberMatch = path.match(/^\/api\/conversations\/([^/]+)\/members(\/me)?$/);
      if (memberMatch) {
        const conv = decodeURIComponent(memberMatch[1]);
        if (req.method === "POST" && !memberMatch[2])
          return await addMember(env, me, conv, AddMemberRequest.parse(await req.json()));
        if (req.method === "DELETE" && memberMatch[2]) return await leaveConversation(env, me, conv);
      }

      if (path === "/api/register-device" && req.method === "POST")
        return userStub(env, me.userId).fetch("https://do/register-device", {
          method: "POST",
          body: JSON.stringify(DeviceRegistration.parse(await req.json())),
        });
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

async function addFriend(env: Env, me: Identity, body: { userId: string }): Promise<Response> {
  const names = await resolveNames(env, [body.userId]);
  const username = names.get(body.userId);
  if (!username) return Response.json({ error: "查无此人" }, { status: 404 });
  await userStub(env, me.userId).fetch("https://do/friends", {
    method: "POST",
    body: JSON.stringify({ userId: body.userId, username }),
  });
  return Response.json({ ok: true, userId: body.userId, username });
}

// 1:1：确定性 conv id，双方任一发起都命中同一会话；双方索引各登记一条。
async function directConversation(env: Env, me: Identity, body: { userId: string }): Promise<Response> {
  if (body.userId === me.userId) return Response.json({ error: "不能和自己聊" }, { status: 400 });
  const names = await resolveNames(env, [body.userId]);
  const peerName = names.get(body.userId);
  if (!peerName) return Response.json({ error: "查无此人" }, { status: 404 });

  const [a, b] = [me.userId, body.userId].sort();
  const conv = `dm_${a}_${b}`;
  await convStub(env, conv).fetch("https://do/init", {
    method: "POST",
    body: JSON.stringify({
      kind: "direct",
      title: "",
      createdBy: me.userId,
      members: [
        { userId: me.userId, username: me.username },
        { userId: body.userId, username: peerName },
      ],
    }),
  });
  await indexConv(env, me.userId, { conv, kind: "direct", peerUserId: body.userId, peerUsername: peerName });
  await indexConv(env, body.userId, { conv, kind: "direct", peerUserId: me.userId, peerUsername: me.username });
  return Response.json({ id: conv }, { status: 201 });
}

async function newGroup(env: Env, me: Identity, body: { title: string; members: string[] }): Promise<Response> {
  const conv = newId("cnv");
  const requested = [...new Set([me.userId, ...body.members])];
  const names = await resolveNames(env, requested);
  // 根因防御：只保留能在目录里解析出用户名的成员（永远含创建者自己）。
  // 否则一个已删除/重注册导致的「幽灵 userId」会被拉进群，真人却进不来（见 mira/jianshuo 事故）。
  const ids = requested.filter((id) => id === me.userId || names.has(id));
  const members = ids.map((id) => ({ userId: id, username: id === me.userId ? me.username : names.get(id)! }));
  await convStub(env, conv).fetch("https://do/init", {
    method: "POST",
    body: JSON.stringify({ kind: "group", title: body.title, createdBy: me.userId, members }),
  });
  for (const id of ids) await indexConv(env, id, { conv, kind: "group", title: body.title });
  await ingestSystem(env, conv, `${me.username} 创建了群「${body.title}」`);
  return Response.json({ id: conv }, { status: 201 });
}

async function addMember(env: Env, me: Identity, conv: string, body: { userId: string }): Promise<Response> {
  const meta = await (await convStub(env, conv).fetch("https://do/meta")).json<{ kind: string; title: string } | null>();
  if (!meta) return Response.json({ error: "会话不存在" }, { status: 404 });
  const names = await resolveNames(env, [body.userId]);
  const username = names.get(body.userId);
  if (!username) return Response.json({ error: "查无此人" }, { status: 404 });
  await convStub(env, conv).fetch("https://do/members", {
    method: "POST",
    body: JSON.stringify({ userId: body.userId, username }),
  });
  await indexConv(env, body.userId, { conv, kind: meta.kind, title: meta.title });
  await ingestSystem(env, conv, `${username} 进群`);
  return Response.json({ ok: true });
}

async function leaveConversation(env: Env, me: Identity, conv: string): Promise<Response> {
  await convStub(env, conv).fetch(`https://do/members/${encodeURIComponent(me.userId)}`, { method: "DELETE" });
  await userStub(env, me.userId).fetch(`https://do/conversations/${encodeURIComponent(conv)}`, { method: "DELETE" });
  await ingestSystem(env, conv, `${me.username} 退群`);
  return Response.json({ ok: true });
}

async function indexConv(
  env: Env,
  userId: string,
  body: { conv: string; kind: string; title?: string; peerUserId?: string; peerUsername?: string }
): Promise<void> {
  await userStub(env, userId).fetch("https://do/index-conv", { method: "POST", body: JSON.stringify(body) });
}

// Worker 直接注入的系统事件（进群/退群/建群），无 senderUserId → ConversationDO 跳过成员校验。
async function ingestSystem(env: Env, conv: string, text: string): Promise<void> {
  await convStub(env, conv).fetch("https://do/ingest", {
    method: "POST",
    body: JSON.stringify({
      event: {
        id: newId("evt"),
        conv,
        ts: nowSec(),
        role: "system",
        agent: "claude-code",
        type: "system",
        body: { text },
      },
    }),
  });
}
