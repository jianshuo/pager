import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

function conv(id: string) {
  return env.CONVERSATION.get(env.CONVERSATION.idFromName(id));
}
function user(id: string) {
  return env.USER.get(env.USER.idFromName(id));
}
async function post(s: DurableObjectStub, path: string, body: unknown) {
  return s.fetch(`https://do${path}`, { method: "POST", body: JSON.stringify(body) });
}
async function convRow(userId: string, convId: string) {
  const list = await (await user(userId).fetch("https://do/conversations")).json<any[]>();
  return list.find((c) => c.id === convId);
}

const textDraft = (id: string, convId: string, markdown: string, author = "自报") => ({
  id,
  conv: convId,
  ts: 1751780500,
  role: "user",
  agent: "claude-code",
  type: "text",
  body: { markdown, author },
});

describe("ConversationDO 成员制扇出", () => {
  it("ingest 扇出到所有成员，并服务端盖 author", async () => {
    const [A, B, c] = ["usr_A1", "usr_B1", "cnv_g1"];
    await post(user(A), "/index-conv", { conv: c, kind: "group", title: "群1" });
    await post(user(B), "/index-conv", { conv: c, kind: "group", title: "群1" });
    await post(conv(c), "/init", {
      kind: "group",
      title: "群1",
      createdBy: A,
      members: [
        { userId: A, username: "alice" },
        { userId: B, username: "bob" },
      ],
    });

    const res = await post(conv(c), "/ingest", {
      event: textDraft("evt_g1", c, "大家好", "冒充别人"),
      senderUsername: "alice",
    });
    const sealed = await res.json<any>();
    expect(sealed.seq).toBe(1);
    expect(sealed.body.author).toBe("alice"); // 服务端盖，压掉自报值

    expect((await convRow(A, c)).lastMessage).toBe("大家好");
    expect((await convRow(B, c)).lastMessage).toBe("大家好");
    expect((await convRow(B, c)).lastSeq).toBe(1);
  });

  it("拉人后 ingest 能到达新成员", async () => {
    const [A, B, C, c] = ["usr_A2", "usr_B2", "usr_C2", "cnv_g2"];
    for (const u of [A, B]) await post(user(u), "/index-conv", { conv: c, kind: "group", title: "群2" });
    await post(conv(c), "/init", {
      kind: "group",
      title: "群2",
      createdBy: A,
      members: [
        { userId: A, username: "alice" },
        { userId: B, username: "bob" },
      ],
    });
    const added = await (await post(conv(c), "/members", { userId: C, username: "carol" })).json<any>();
    expect(added.added).toBe(true);
    await post(user(C), "/index-conv", { conv: c, kind: "group", title: "群2" });

    await post(conv(c), "/ingest", { event: textDraft("evt_g2", c, "欢迎 carol"), senderUsername: "alice" });
    expect((await convRow(C, c)).lastMessage).toBe("欢迎 carol");

    const members = await (await conv(c).fetch("https://do/members")).json<any[]>();
    expect(members.map((m) => m.userId).sort()).toEqual([A, B, C].sort());
  });

  it("system 事件的 lastMessage 用其 text", async () => {
    const [A, c] = ["usr_A3", "cnv_g3"];
    await post(user(A), "/index-conv", { conv: c, kind: "group", title: "群3" });
    await post(conv(c), "/init", { kind: "group", title: "群3", createdBy: A, members: [{ userId: A, username: "alice" }] });
    await post(conv(c), "/ingest", {
      event: { id: "evt_sys", conv: c, ts: 1751780600, role: "system", agent: "claude-code", type: "system", body: { text: "carol 进群" } },
    });
    expect((await convRow(A, c)).lastMessage).toBe("carol 进群");
  });

  it("init 幂等：二次 init 不覆盖已有会话，只补成员", async () => {
    const [A, B, c] = ["usr_A4", "usr_B4", "dm_usr_A4_usr_B4"];
    await post(conv(c), "/init", { kind: "direct", title: "", createdBy: A, members: [{ userId: A, username: "alice" }] });
    await post(conv(c), "/init", { kind: "direct", title: "", createdBy: B, members: [{ userId: B, username: "bob" }] });
    const meta = await (await conv(c).fetch("https://do/meta")).json<any>();
    expect(meta.createdBy).toBe(A); // 首次 createdBy 保留
    const members = await (await conv(c).fetch("https://do/members")).json<any[]>();
    expect(members.map((m) => m.userId).sort()).toEqual([A, B].sort());
  });
});
