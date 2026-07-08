import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { until } from "./util.js";

function user(id: string) {
  return env.USER.get(env.USER.idFromName(id));
}
function conv(id: string) {
  return env.CONVERSATION.get(env.CONVERSATION.idFromName(id));
}
async function post(s: DurableObjectStub, path: string, body: unknown) {
  return s.fetch(`https://do${path}`, { method: "POST", body: JSON.stringify(body) });
}

// 直接对某个 UserDO 开一条已带身份的 client WS（Worker 在 Phase 4 才会做鉴权+转发）
async function userWs(userId: string, username: string) {
  const res = await user(userId).fetch(`https://do/ws?user=${userId}&name=${username}`, {
    headers: { Upgrade: "websocket" },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  const got: any[] = [];
  ws.addEventListener("message", (ev) => got.push(JSON.parse(ev.data as string)));
  return { ws, got };
}

describe("UserDO 每用户空间", () => {
  it("加好友 + 列表", async () => {
    const A = "usr_f1";
    await post(user(A), "/friends", { userId: "usr_peer", username: "peer" });
    await post(user(A), "/friends", { userId: "usr_peer", username: "peer" }); // 幂等
    const friends = await (await user(A).fetch("https://do/friends")).json<any[]>();
    expect(friends).toEqual([{ userId: "usr_peer", username: "peer" }]);
  });

  it("index-conv 登记会话，GET /conversations 可见", async () => {
    const A = "usr_f2";
    await post(user(A), "/index-conv", { conv: "dm_x", kind: "direct", peerUserId: "usr_z", peerUsername: "zoe" });
    const list = await (await user(A).fetch("https://do/conversations")).json<any[]>();
    expect(list.find((c) => c.id === "dm_x")).toMatchObject({ kind: "direct", peerUsername: "zoe" });
  });

  it("WS send → ConversationDO 盖 seq+author → 扇回本设备广播", async () => {
    const A = "usr_f3";
    const c = "cnv_send3";
    await post(user(A), "/index-conv", { conv: c, kind: "group", title: "群" });
    await post(conv(c), "/init", { kind: "group", title: "群", createdBy: A, members: [{ userId: A, username: "alice" }] });

    const { ws, got } = await userWs(A, "alice");
    ws.send(
      JSON.stringify({
        kind: "send",
        conv: c,
        event: { id: "evt_s3", conv: c, ts: 1751780700, role: "user", agent: "claude-code", type: "text", body: { markdown: "手机发的", author: "假" } },
      })
    );
    const frame = await until(async () => got.find((g) => g.kind === "event" && g.event.id === "evt_s3"));
    expect(frame.event.seq).toBeGreaterThanOrEqual(1);
    expect(frame.event.body.author).toBe("alice"); // 服务端盖
    ws.close();
  });

  it("subscribe 从 ConversationDO 补 backlog", async () => {
    const A = "usr_f4";
    const c = "cnv_sub4";
    await post(user(A), "/index-conv", { conv: c, kind: "group", title: "群" });
    await post(conv(c), "/init", { kind: "group", title: "群", createdBy: A, members: [{ userId: A, username: "alice" }] });
    for (const n of [1, 2, 3]) {
      await post(conv(c), "/ingest", {
        event: { id: `evt_b${n}`, conv: c, ts: 1751780800 + n, role: "user", agent: "claude-code", type: "text", body: { markdown: `m${n}` } },
        senderUsername: "alice",
      });
    }
    const { ws, got } = await userWs(A, "alice");
    ws.send(JSON.stringify({ kind: "subscribe", conv: c, afterSeq: 1 }));
    await until(async () => got.filter((g) => g.kind === "event" && g.event.conv === c).length >= 2);
    const seqs = got.filter((g) => g.kind === "event" && g.event.conv === c).map((g) => g.event.seq).sort();
    expect(seqs).toEqual([2, 3]);
    ws.close();
  });

  it("register-device 落库（供离线推送）", async () => {
    const A = "usr_f5";
    const r = await post(user(A), "/register-device", { deviceToken: "dev-abc" });
    expect((await r.json<any>()).ok).toBe(true);
  });
});
