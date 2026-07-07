import { SELF, env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { until } from "./util.js";

const HELLO = {
  kind: "hello",
  proto: 1,
  machine: { id: "mch_t", name: "TestMac" },
  dirs: ["/proj/a", "/proj/b"],
  maxConcurrent: 2,
};

async function daemonWs(machine = "mch_t") {
  const res = await SELF.fetch(`https://hub/ws/daemon?machine=${machine}`, {
    headers: { Upgrade: "websocket", Authorization: "Bearer test-daemon-token" },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  return ws;
}

function machineStub(id = "mch_t") {
  return env.MACHINE.get(env.MACHINE.idFromName(id));
}

describe("MachineDO", () => {
  it("hello 后 /info 在线且带目录", async () => {
    const ws = await daemonWs();
    ws.send(JSON.stringify(HELLO));
    const info = await until(async () => {
      const r = await (await machineStub().fetch("https://do/info")).json<any>();
      return r?.online ? r : null;
    });
    expect(info.machine).toEqual({ id: "mch_t", name: "TestMac" });
    expect(info.dirs).toEqual(["/proj/a", "/proj/b"]);
    expect(info.proto).toBe(1);
    ws.close();
  });

  it("deliver 在线送达、离线 false", async () => {
    const ws = await daemonWs("mch_d");
    const got: string[] = [];
    ws.addEventListener("message", (ev) => got.push(ev.data as string));
    ws.send(JSON.stringify({ ...HELLO, machine: { id: "mch_d", name: "D" } }));
    await until(async () => (await (await machineStub("mch_d").fetch("https://do/info")).json<any>())?.online);

    const task = { kind: "interrupt", conv: "cnv_x" };
    const r1 = await (
      await machineStub("mch_d").fetch("https://do/deliver", { method: "POST", body: JSON.stringify(task) })
    ).json<any>();
    expect(r1.delivered).toBe(true);
    await until(async () => got.length > 0);
    expect(JSON.parse(got[0]).kind).toBe("interrupt");

    ws.close();
    await until(async () => {
      const r = await (await machineStub("mch_d").fetch("https://do/info")).json<any>();
      return r && !r.online;
    });
    const r2 = await (
      await machineStub("mch_d").fetch("https://do/deliver", { method: "POST", body: JSON.stringify(task) })
    ).json<any>();
    expect(r2.delivered).toBe(false);
  });

  it("daemon event 路由到 ConversationDO 并盖 seq", async () => {
    const conv = env.CONVERSATION.get(env.CONVERSATION.idFromName("cnv_route"));
    await conv.fetch("https://do/init", {
      method: "POST",
      body: JSON.stringify({ machineId: "mch_r", machineName: "R", dir: "/x" }),
    });
    const ws = await daemonWs("mch_r");
    ws.send(JSON.stringify({ ...HELLO, machine: { id: "mch_r", name: "R" } }));
    ws.send(
      JSON.stringify({
        kind: "event",
        event: {
          id: "evt_r1",
          conv: "cnv_route",
          ts: 1751780001,
          role: "agent",
          agent: "claude-code",
          type: "text",
          body: { markdown: "hi from daemon" },
        },
      })
    );
    const events = await until(async () => {
      const list = await (await conv.fetch("https://do/events?after=0")).json<any[]>();
      return list.length > 0 ? list : null;
    });
    expect(events[0].seq).toBe(1);
    expect(events[0].body.markdown).toBe("hi from daemon");
    ws.close();
  });

  it("非法 JSON 与非法消息不炸 socket", async () => {
    const ws = await daemonWs("mch_bad");
    ws.send("not json");
    ws.send(JSON.stringify({ kind: "hello", nope: true }));
    ws.send(JSON.stringify({ ...HELLO, machine: { id: "mch_bad", name: "B" } }));
    const info = await until(async () => {
      const r = await (await machineStub("mch_bad").fetch("https://do/info")).json<any>();
      return r?.online ? r : null;
    });
    expect(info.machine.name).toBe("B");
    ws.close();
  });
});
