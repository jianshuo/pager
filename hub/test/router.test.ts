import { SELF, env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { until } from "./util.js";

async function api(path: string, opts: { token?: string; method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return SELF.fetch(`https://hub${path}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}
async function register(username: string) {
  const r = await api("/api/register", { body: { username, password: "hunter2" } });
  expect(r.status).toBe(200);
  return r.json<{ userId: string; username: string; token: string }>();
}
async function clientWs(token: string) {
  const res = await SELF.fetch("https://hub/ws/client", {
    headers: { Upgrade: "websocket", Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  const got: any[] = [];
  ws.addEventListener("message", (ev) => got.push(JSON.parse(ev.data as string)));
  return { ws, got };
}

describe("router：账号与鉴权", () => {
  it("health 免认证", async () => {
    expect(await (await api("/health")).json()).toEqual({ ok: true });
  });

  it("无 token 一律 401", async () => {
    expect((await api("/api/conversations")).status).toBe(401);
    expect((await SELF.fetch("https://hub/ws/client")).status).toBe(401);
  });

  it("注册发 token；错密码登录 401", async () => {
    const { token, userId } = await register("r_alice");
    expect(token.startsWith("stk_")).toBe(true);
    expect(userId.startsWith("usr_")).toBe(true);
    expect((await api("/api/login", { body: { username: "r_alice", password: "wrongpass" } })).status).toBe(401);
    const me = await (await api("/api/me", { token })).json<any>();
    expect(me.username).toBe("r_alice");
  });
});

describe("router：好友与 1:1", () => {
  it("搜人→加好友→建直连→双方可见→互发送达", async () => {
    const alice = await register("r_bob_a");
    const bob = await register("r_bob_b");

    // alice 搜 bob
    const found = await (await api(`/api/users?q=r_bob_b`, { token: alice.token })).json<any[]>();
    expect(found.find((u) => u.userId === bob.userId)).toBeTruthy();

    // alice 加 bob 好友
    await api("/api/friends", { token: alice.token, body: { userId: bob.userId } });
    const friends = await (await api("/api/friends", { token: alice.token })).json<any[]>();
    expect(friends.find((f) => f.userId === bob.userId)?.username).toBe("r_bob_b");

    // 建直连
    const dc = await (await api("/api/conversations/direct", { token: alice.token, body: { userId: bob.userId } })).json<any>();
    expect(dc.id.startsWith("dm_")).toBe(true);

    // 双方会话列表都含它
    const aList = await (await api("/api/conversations", { token: alice.token })).json<any[]>();
    const bList = await (await api("/api/conversations", { token: bob.token })).json<any[]>();
    expect(aList.find((c) => c.id === dc.id)?.peerUsername).toBe("r_bob_b");
    expect(bList.find((c) => c.id === dc.id)?.peerUsername).toBe("r_bob_a");

    // bob 订阅，alice 发消息 → bob 收到，author 被服务端盖成 alice
    const b = await clientWs(bob.token);
    b.ws.send(JSON.stringify({ kind: "subscribe", conv: dc.id, afterSeq: 0 }));
    const a = await clientWs(alice.token);
    a.ws.send(
      JSON.stringify({
        kind: "send",
        conv: dc.id,
        event: { id: "evt_dm1", conv: dc.id, ts: 1751781000, role: "user", agent: "claude-code", type: "text", body: { markdown: "在吗", author: "假名" } },
      })
    );
    const frame = await until(async () => b.got.find((g) => g.kind === "event" && g.event.id === "evt_dm1"));
    expect(frame.event.body.markdown).toBe("在吗");
    expect(frame.event.body.author).toBe("r_bob_a");
    a.ws.close();
    b.ws.close();
  });
});

describe("router：群与拉人", () => {
  it("建群→双方可见→拉第三人→三方可见 + 进群系统消息", async () => {
    const a = await register("r_grp_a");
    const b = await register("r_grp_b");
    const c = await register("r_grp_c");

    const g = await (await api("/api/groups", { token: a.token, body: { title: "家人群", members: [b.userId] } })).json<any>();
    expect(g.id.startsWith("cnv_")).toBe(true);

    let bList = await (await api("/api/conversations", { token: b.token })).json<any[]>();
    expect(bList.find((x) => x.id === g.id)?.title).toBe("家人群");

    // a 拉 c
    const add = await api(`/api/conversations/${g.id}/members`, { token: a.token, body: { userId: c.userId } });
    expect(add.status).toBe(200);
    const cList = await (await api("/api/conversations", { token: c.token })).json<any[]>();
    expect(cList.find((x) => x.id === g.id)?.title).toBe("家人群");

    // c 订阅能看到「进群」系统消息在 backlog 里
    const cw = await clientWs(c.token);
    cw.ws.send(JSON.stringify({ kind: "subscribe", conv: g.id, afterSeq: 0 }));
    const sys = await until(async () =>
      cw.got.find((x) => x.kind === "event" && x.event.type === "system" && x.event.body.text.includes("进群"))
    );
    expect(sys.event.body.text).toContain("r_grp_c");
    cw.ws.close();
  });

  it("GET /api/bots 列出 Claude/ChatGPT", async () => {
    const a = await register("r_bots_a");
    const bots = await (await api("/api/bots", { token: a.token })).json<any[]>();
    expect(bots.map((b: any) => b.username).sort()).toEqual(["chatgpt", "claude"]);
  });

  it("建干活 bot（绑机器目录）→ /api/bots 含它(backend=agent)", async () => {
    const a = await register("r_agent_a");
    const made = await api("/api/bots", { token: a.token, body: { name: "mybot" + Math.floor(Math.random() * 9999), machineId: "mch_x", dir: "/tmp" } });
    expect(made.status).toBe(200);
    const { userId } = await made.json<any>();
    const bots = await (await api("/api/bots", { token: a.token })).json<any[]>();
    const mine = bots.find((b: any) => b.userId === userId);
    expect(mine.backend).toBe("agent");
    // 另一个人看不到我的 agent bot（只看到内置）
    const b = await register("r_agent_b");
    const bBots = await (await api("/api/bots", { token: b.token })).json<any[]>();
    expect(bBots.find((x: any) => x.userId === userId)).toBeUndefined();
    expect(bBots.map((x: any) => x.username).sort()).toEqual(["chatgpt", "claude"]);
  });

  it("和 Claude 建直连→发消息→收到 bot 流式回复(mock)", async () => {
    const a = await register("r_bots_b");
    const dc = await (
      await api("/api/conversations/direct", { token: a.token, body: { userId: "usr_bot_claude" } })
    ).json<any>();
    const w = await clientWs(a.token);
    w.ws.send(JSON.stringify({ kind: "subscribe", conv: dc.id, afterSeq: 0 }));
    w.ws.send(
      JSON.stringify({
        kind: "send",
        conv: dc.id,
        event: { id: "evt_b1", conv: dc.id, ts: 1, role: "user", agent: "claude-code", type: "text", body: { markdown: "讲个笑话", author: "r_bots_b" } },
      })
    );
    const bot = await until(async () =>
      w.got.find((g: any) => g.kind === "event" && g.event.role === "agent") || w.got.find((g: any) => g.kind === "patch")
    );
    expect(bot).toBeTruthy();
    w.ws.close();
  });

  // 回归：mira/jianshuo 事故——已删除/重注册留下的「幽灵 userId」不能被拉进群（否则真人进不来）
  it("建群时无法解析的幽灵成员被过滤，只留创建者+真实成员", async () => {
    const a = await register("r_ghost_a");
    const real = await register("r_ghost_real");
    const g = await (
      await api("/api/groups", {
        token: a.token,
        body: { title: "防幽灵", members: [real.userId, "usr_ghost_deadbeef"] },
      })
    ).json<any>();
    const conv = env.CONVERSATION.get(env.CONVERSATION.idFromName(g.id));
    const members = await (await conv.fetch("https://do/members")).json<any[]>();
    const ids = members.map((m) => m.userId).sort();
    expect(ids).toEqual([a.userId, real.userId].sort()); // 幽灵 usr_ghost_deadbeef 不在其中
  });
});
