import { SELF, env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { until } from "./util.js";

function userStub() {
  return env.USER.get(env.USER.idFromName("user"));
}

async function post(s: DurableObjectStub, path: string, body: unknown) {
  return s.fetch(`https://do${path}`, { method: "POST", body: JSON.stringify(body) });
}

async function clientWs() {
  const res = await SELF.fetch("https://hub/ws/client", {
    headers: { Upgrade: "websocket", Authorization: "Bearer test-client-token" },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  const got: any[] = [];
  ws.addEventListener("message", (ev) => got.push(JSON.parse(ev.data as string)));
  return { ws, got };
}

const NOTIFY = {
  conv: "cnv_u1",
  event: {
    id: "evt_u1",
    conv: "cnv_u1",
    seq: 1,
    ts: 1751780100,
    role: "agent",
    agent: "claude-code",
    type: "text",
    body: { markdown: "hello user" },
  },
  meta: { machineId: "mch_u", machineName: "Mac", dir: "/p", state: "running" },
  summary: { state: "running", lastMessage: "hello user", lastSeq: 1, updatedAt: 1751780100 },
};

describe("UserDO", () => {
  it("notify 落索引表并广播", async () => {
    const { ws, got } = await clientWs();
    await post(userStub(), "/notify", NOTIFY);
    const frame = await until(async () => got.find((g) => g.kind === "event" && g.event.id === "evt_u1"));
    expect(frame).toEqual({ kind: "event", event: NOTIFY.event });

    const list = await (await userStub().fetch("https://do/conversations")).json<any[]>();
    const row = list.find((c) => c.id === "cnv_u1");
    expect(row).toMatchObject({
      machineId: "mch_u",
      machineName: "Mac",
      dir: "/p",
      state: "running",
      lastMessage: "hello user",
      lastSeq: 1,
      updatedAt: 1751780100,
    });
    ws.close();
  });

  it("machine-status upsert + 广播 + GET /machines", async () => {
    const { ws, got } = await clientWs();
    await post(userStub(), "/machine-status", {
      machine: { id: "mch_u2", name: "VPS" },
      online: true,
      dirs: ["/srv"],
      maxConcurrent: 1,
    });
    const frame = await until(async () =>
      got.find((g) => g.kind === "machine_status" && g.machine?.id === "mch_u2")
    );
    expect(frame).toEqual({ kind: "machine_status", machine: { id: "mch_u2", name: "VPS" }, online: true });
    const machines = await (await userStub().fetch("https://do/machines")).json<any[]>();
    expect(machines.find((m) => m.id === "mch_u2")).toMatchObject({ name: "VPS", online: true, dirs: ["/srv"] });
    ws.close();
  });

  it("subscribe 从 ConversationDO 补 backlog", async () => {
    const conv = env.CONVERSATION.get(env.CONVERSATION.idFromName("cnv_sub"));
    await conv.fetch("https://do/init", {
      method: "POST",
      body: JSON.stringify({ machineId: "mch_u", machineName: "Mac", dir: "/p" }),
    });
    for (const n of [1, 2, 3]) {
      await conv.fetch("https://do/ingest", {
        method: "POST",
        body: JSON.stringify({
          event: {
            id: `evt_s${n}`,
            conv: "cnv_sub",
            ts: 1751780200 + n,
            role: "agent",
            agent: "claude-code",
            type: "text",
            body: { markdown: `m${n}` },
          },
        }),
      });
    }
    const { ws, got } = await clientWs();
    ws.send(JSON.stringify({ kind: "subscribe", conv: "cnv_sub", afterSeq: 1 }));
    await until(async () => got.filter((g) => g.kind === "event" && g.event.conv === "cnv_sub").length >= 2);
    const seqs = got.filter((g) => g.kind === "event" && g.event.conv === "cnv_sub").map((g) => g.event.seq);
    expect(seqs).toEqual([2, 3]);
    ws.close();
  });

  it("send 盖 seq 落库并 deliver 给 daemon", async () => {
    // 先立一个假 daemon 接消息
    const dres = await SELF.fetch("https://hub/ws/daemon?machine=mch_send", {
      headers: { Upgrade: "websocket", Authorization: "Bearer test-daemon-token" },
    });
    const dws = dres.webSocket!;
    dws.accept();
    const dgot: any[] = [];
    dws.addEventListener("message", (ev) => dgot.push(JSON.parse(ev.data as string)));
    dws.send(
      JSON.stringify({
        kind: "hello",
        proto: 1,
        machine: { id: "mch_send", name: "S" },
        dirs: ["/p"],
        maxConcurrent: 1,
      })
    );

    const conv = env.CONVERSATION.get(env.CONVERSATION.idFromName("cnv_send"));
    await conv.fetch("https://do/init", {
      method: "POST",
      body: JSON.stringify({ machineId: "mch_send", machineName: "S", dir: "/p" }),
    });
    // 让 UserDO 的索引表知道这个会话属于哪台机器
    await post(userStub(), "/notify", {
      ...NOTIFY,
      conv: "cnv_send",
      event: { ...NOTIFY.event, id: "evt_seed", conv: "cnv_send" },
      meta: { machineId: "mch_send", machineName: "S", dir: "/p", state: "running" },
    });

    const { ws, got } = await clientWs();
    ws.send(
      JSON.stringify({
        kind: "send",
        conv: "cnv_send",
        event: {
          id: "evt_usend",
          conv: "cnv_send",
          ts: 1751780300,
          role: "user",
          agent: "claude-code",
          type: "text",
          body: { markdown: "从手机发的" },
        },
      })
    );
    const userEvent = await until(async () => dgot.find((m) => m.kind === "user_event"));
    expect(userEvent.conv).toBe("cnv_send");
    expect(userEvent.event.seq).toBeGreaterThanOrEqual(1);
    expect(userEvent.event.body.markdown).toBe("从手机发的");
    // 自己的消息也广播回来（多设备同步）
    await until(async () => got.some((g) => g.kind === "event" && g.event.id === "evt_usend"));
    ws.close();
    dws.close();
  });

  it("机器离线广播", async () => {
    const { ws, got } = await clientWs();

    const dres = await SELF.fetch("https://hub/ws/daemon?machine=mch_off", {
      headers: { Upgrade: "websocket", Authorization: "Bearer test-daemon-token" },
    });
    expect(dres.status).toBe(101);
    const dws = dres.webSocket!;
    dws.accept();
    dws.send(
      JSON.stringify({
        kind: "hello",
        proto: 1,
        machine: { id: "mch_off", name: "Offline" },
        dirs: ["/off"],
        maxConcurrent: 1,
      })
    );

    await until(async () =>
      got.find((g) => g.kind === "machine_status" && g.machine?.id === "mch_off" && g.online === true)
    );

    dws.close();

    const offline = await until(async () =>
      got.find((g) => g.kind === "machine_status" && g.machine?.id === "mch_off" && g.online === false)
    );
    expect(offline).toEqual({ kind: "machine_status", machine: { id: "mch_off", name: "Offline" }, online: false });
    ws.close();
  });
});
