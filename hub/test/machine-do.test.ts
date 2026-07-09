import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { until } from "./util.js";

// 假 daemon 连上 MachineDO，回放 event/permission；验证以 bot 身份落回会话 + owner_id。
describe("MachineDO agent bot 回话", () => {
  it("task 派发后 daemon 回的 event 以 bot 身份 ingest，权限带 owner_id", async () => {
    const machineId = "mch_agenttest";
    const conv = "cnv_agent1";
    const convStub = env.CONVERSATION.get(env.CONVERSATION.idFromName(conv));
    // 会话里放一个 agent bot 成员
    await convStub.fetch("https://do/init", {
      method: "POST",
      body: JSON.stringify({ kind: "group", title: "工作", createdBy: "usr_owner", members: [{ userId: "usr_owner", username: "owner", isBot: false }] }),
    });

    // 假 daemon 上线
    const dres = await SELF.fetch(`https://hub/ws/daemon?machine=${machineId}`, {
      headers: { Upgrade: "websocket", Authorization: "Bearer test-daemon-token" },
    });
    expect(dres.status).toBe(101);
    const dws = dres.webSocket!;
    dws.accept();
    dws.send(JSON.stringify({ kind: "hello", proto: 1, machine: { id: machineId, name: "TestMac" }, dirs: ["/tmp"], maxConcurrent: 1 }));

    // hub 派 task（带 bot 身份）
    const machineStub = env.MACHINE.get(env.MACHINE.idFromName(machineId));
    await machineStub.fetch("https://do/deliver", {
      method: "POST",
      body: JSON.stringify({
        kind: "task", conv, dir: "/tmp", agent: "claude-code",
        botUsername: "workbot", ownerId: "usr_owner",
        event: { id: "evt_task", conv, ts: 1, role: "user", agent: "claude-code", type: "text", body: { markdown: "看看目录" } },
      }),
    });

    // daemon 回一条 text + 一条 permission_request
    dws.send(JSON.stringify({ kind: "event", event: { id: "evt_reply", conv, ts: 2, role: "agent", agent: "claude-code", type: "text", body: { markdown: "有 3 个文件" } } }));
    dws.send(JSON.stringify({ kind: "event", event: { id: "evt_perm", conv, ts: 3, role: "agent", agent: "claude-code", type: "permission_request", body: { request_id: "r1", tool: "Bash", description: "rm x", options: ["allow", "deny"] } } }));

    const events = await until(async () => {
      const list = await (await convStub.fetch("https://do/events?after=0")).json<any[]>();
      const reply = list.find((e) => e.id === "evt_reply");
      const perm = list.find((e) => e.id === "evt_perm");
      return reply && perm ? { reply, perm } : null;
    });
    expect(events.reply.body.author).toBe("workbot"); // 盖上 bot 身份
    expect(events.reply.role).toBe("agent");
    expect(events.perm.body.owner_id).toBe("usr_owner"); // 权限带 owner
    dws.close();
  });
});
