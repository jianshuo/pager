import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { until } from "./util.js";

const CLIENT = { Authorization: "Bearer test-client-token" };

async function api(path: string, init: RequestInit = {}) {
  return SELF.fetch(`https://hub${path}`, { ...init, headers: { ...CLIENT, ...(init.headers ?? {}) } });
}

async function fakeDaemon(machineId: string, dirs = ["/proj/a"]) {
  const res = await SELF.fetch(`https://hub/ws/daemon?machine=${machineId}`, {
    headers: { Upgrade: "websocket", Authorization: "Bearer test-daemon-token" },
  });
  const ws = res.webSocket!;
  ws.accept();
  const got: any[] = [];
  ws.addEventListener("message", (ev) => got.push(JSON.parse(ev.data as string)));
  ws.send(
    JSON.stringify({
      kind: "hello",
      proto: 1,
      machine: { id: machineId, name: `M-${machineId}` },
      dirs,
      maxConcurrent: 2,
    })
  );
  await until(async () => {
    const machines = await (await api("/api/machines")).json<any[]>();
    return machines.find((m) => m.id === machineId && m.online);
  });
  return { ws, got };
}

describe("REST API", () => {
  it("register-device 200", async () => {
    const res = await api("/api/register-device", { method: "POST", body: JSON.stringify({ deviceToken: "tok1" }) });
    expect(res.status).toBe(200);
  });

  it("新建会话：201 返回 cnv id，daemon 收到 task，列表出现该会话", async () => {
    const { ws, got } = await fakeDaemon("mch_api1");
    const res = await api("/api/conversations", {
      method: "POST",
      body: JSON.stringify({ machineId: "mch_api1", dir: "/proj/a", message: "帮我跑测试" }),
    });
    expect(res.status).toBe(201);
    const { id } = await res.json<any>();
    expect(id.startsWith("cnv_")).toBe(true);

    const task = await until(async () => got.find((m) => m.kind === "task"));
    expect(task.conv).toBe(id);
    expect(task.dir).toBe("/proj/a");
    expect(task.event.seq).toBe(1);
    expect(task.event.body.markdown).toBe("帮我跑测试");

    const list = await (await api("/api/conversations")).json<any[]>();
    expect(list.find((c) => c.id === id)).toMatchObject({ machineId: "mch_api1", dir: "/proj/a" });
    ws.close();
  });

  it("机器离线新建会话 409", async () => {
    const res = await api("/api/conversations", {
      method: "POST",
      body: JSON.stringify({ machineId: "mch_offline", dir: "/proj/a", message: "hi" }),
    });
    expect(res.status).toBe(409);
  });

  it("dir 不在白名单 400", async () => {
    const { ws } = await fakeDaemon("mch_api2");
    const res = await api("/api/conversations", {
      method: "POST",
      body: JSON.stringify({ machineId: "mch_api2", dir: "/etc", message: "hi" }),
    });
    expect(res.status).toBe(400);
    ws.close();
  });

  it("permission-response 走 ingest 并 deliver 给 daemon", async () => {
    const { ws, got } = await fakeDaemon("mch_api3");
    const res = await api("/api/conversations", {
      method: "POST",
      body: JSON.stringify({ machineId: "mch_api3", dir: "/proj/a", message: "做点危险的事" }),
    });
    const { id } = await res.json<any>();
    const pr = await api("/api/permission-response", {
      method: "POST",
      body: JSON.stringify({ conv: id, request_id: "req_1", choice: "allow" }),
    });
    expect(pr.status).toBe(200);
    const ue = await until(async () => got.find((m) => m.kind === "user_event"));
    expect(ue.event.type).toBe("permission_response");
    expect(ue.event.body).toEqual({ request_id: "req_1", choice: "allow" });
    ws.close();
  });

  it("permission-response 未知会话 404", async () => {
    const res = await api("/api/permission-response", {
      method: "POST",
      body: JSON.stringify({ conv: "cnv_ghost", request_id: "r", choice: "deny" }),
    });
    expect(res.status).toBe(404);
  });

  it("body 校验失败 400", async () => {
    const res = await api("/api/conversations", {
      method: "POST",
      body: JSON.stringify({ machineId: "mch_x", dir: "/a", message: "" }),
    });
    expect(res.status).toBe(400);
  });
});
