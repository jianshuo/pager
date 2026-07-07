import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

function stub(name: string) {
  return env.CONVERSATION.get(env.CONVERSATION.idFromName(name));
}

async function post(s: DurableObjectStub, path: string, body: unknown) {
  return s.fetch(`https://do${path}`, { method: "POST", body: JSON.stringify(body) });
}

const draft = (conv: string, n: number, over: Record<string, unknown> = {}) => ({
  id: `evt_${n}`,
  conv,
  ts: 1751780000 + n,
  role: "agent",
  agent: "claude-code",
  type: "text",
  body: { markdown: `msg ${n}` },
  ...over,
});

describe("ConversationDO", () => {
  it("init 存 meta，初始 state=thinking", async () => {
    const s = stub("cnv_a");
    const res = await post(s, "/init", { machineId: "mch_m", machineName: "Mac", dir: "/x" });
    expect(res.status).toBe(200);
    const meta = await (await s.fetch("https://do/meta")).json<any>();
    expect(meta).toEqual({ machineId: "mch_m", machineName: "Mac", dir: "/x", state: "thinking" });
  });

  it("ingest 依次盖 seq，events?after 增量补齐", async () => {
    const s = stub("cnv_b");
    await post(s, "/init", { machineId: "mch_m", machineName: "Mac", dir: "/x" });
    const e1 = await (await post(s, "/ingest", { event: draft("cnv_b", 1) })).json<any>();
    const e2 = await (await post(s, "/ingest", { event: draft("cnv_b", 2) })).json<any>();
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    const after1 = await (await s.fetch("https://do/events?after=1")).json<any[]>();
    expect(after1.map((e) => e.seq)).toEqual([2]);
    const all = await (await s.fetch("https://do/events?after=0")).json<any[]>();
    expect(all.map((e) => e.id)).toEqual(["evt_1", "evt_2"]);
  });

  it("未知 type 的事件照收（宽松姿态）", async () => {
    const s = stub("cnv_c");
    await post(s, "/init", { machineId: "mch_m", machineName: "Mac", dir: "/x" });
    const res = await post(s, "/ingest", {
      event: draft("cnv_c", 1, { type: "voice_note", body: { url: "x" } }),
    });
    expect(res.status).toBe(200);
    expect((await res.json<any>()).type).toBe("voice_note");
  });

  it("status 事件更新 meta.state", async () => {
    const s = stub("cnv_d");
    await post(s, "/init", { machineId: "mch_m", machineName: "Mac", dir: "/x" });
    await post(s, "/ingest", { event: draft("cnv_d", 1, { type: "status", body: { state: "done" } }) });
    const meta = await (await s.fetch("https://do/meta")).json<any>();
    expect(meta.state).toBe("done");
  });

  it("patch 改写 text 事件的 markdown（落库存最终版）", async () => {
    const s = stub("cnv_e");
    await post(s, "/init", { machineId: "mch_m", machineName: "Mac", dir: "/x" });
    await post(s, "/ingest", { event: draft("cnv_e", 1) });
    const res = await post(s, "/patch", { conv: "cnv_e", eventId: "evt_1", markdown: "final text" });
    expect(res.status).toBe(200);
    const all = await (await s.fetch("https://do/events?after=0")).json<any[]>();
    expect(all[0].body.markdown).toBe("final text");
  });

  it("patch 未知 eventId 404", async () => {
    const s = stub("cnv_f");
    await post(s, "/init", { machineId: "mch_m", machineName: "Mac", dir: "/x" });
    expect((await post(s, "/patch", { conv: "cnv_f", eventId: "evt_nope", markdown: "x" })).status).toBe(404);
  });

  it("session 记 agentSessionId", async () => {
    const s = stub("cnv_g");
    await post(s, "/init", { machineId: "mch_m", machineName: "Mac", dir: "/x" });
    await post(s, "/session", { conv: "cnv_g", agentSessionId: "sess-1" });
    const meta = await (await s.fetch("https://do/meta")).json<any>();
    expect(meta.agentSessionId).toBe("sess-1");
  });

  it("ingest 非法 envelope 400", async () => {
    const s = stub("cnv_h");
    await post(s, "/init", { machineId: "mch_m", machineName: "Mac", dir: "/x" });
    expect((await post(s, "/ingest", { event: { id: "bad" } })).status).toBe(400);
  });

  it("未 /init 直接 ingest 409（不再用空壳 meta 兜底）", async () => {
    const s = stub("cnv_i");
    const res = await post(s, "/ingest", { event: draft("cnv_i", 1) });
    expect(res.status).toBe(409);
    const meta = await (await s.fetch("https://do/meta")).json<any>();
    expect(meta).toBeNull();
  });
});
