import { describe, it, expect } from "vitest";
import { Event, EventDraft, EventLoose, EventDraftLoose } from "../src/event.js";

const validText = {
  id: "evt_1",
  conv: "cnv_1",
  seq: 1,
  ts: 1751780000,
  role: "agent",
  agent: "claude-code",
  type: "text",
  body: { markdown: "hello **world**" },
};

describe("Event", () => {
  it("解析合法 text 事件", () => {
    expect(Event.parse(validText)).toEqual(validText);
  });

  it("agent 字段缺省为 claude-code", () => {
    const { agent, ...noAgent } = validText;
    expect(Event.parse(noAgent).agent).toBe("claude-code");
  });

  it("拒绝未知 type", () => {
    expect(() => Event.parse({ ...validText, type: "nope" })).toThrow();
  });

  it("拒绝 type 与 body 不匹配（text 配 tool_card body）", () => {
    expect(() =>
      Event.parse({ ...validText, body: { tool: "Bash", title: "x" } })
    ).toThrow();
  });

  it("拒绝错误 id 前缀", () => {
    expect(() => Event.parse({ ...validText, id: "x_1" })).toThrow();
  });

  it("解析 permission_request 事件", () => {
    const evt = {
      ...validText,
      type: "permission_request",
      role: "agent",
      body: {
        request_id: "req_1",
        tool: "Bash",
        description: "运行 rm -rf build/",
        options: ["allow", "deny", "allow_always"],
      },
    };
    expect(Event.parse(evt).type).toBe("permission_request");
  });

  it("拒绝 permission_request 的非法 choice 选项", () => {
    const evt = {
      ...validText,
      type: "permission_request",
      body: { request_id: "r", tool: "Bash", description: "d", options: ["maybe"] },
    };
    expect(() => Event.parse(evt)).toThrow();
  });

  it("解析 status 事件并拒绝非法 state", () => {
    const ok = { ...validText, type: "status", body: { state: "running" } };
    expect(Event.parse(ok).body).toEqual({ state: "running" });
    expect(() =>
      Event.parse({ ...validText, type: "status", body: { state: "paused" } })
    ).toThrow();
  });
});

describe("EventDraft", () => {
  it("无 seq 可解析", () => {
    const { seq, ...draft } = validText;
    expect(EventDraft.parse(draft)).toEqual(draft);
  });

  it("Event 缺 seq 应报错（与 Draft 的区别）", () => {
    const { seq, ...draft } = validText;
    expect(() => Event.parse(draft)).toThrow();
  });

  // hub 会重新盖 seq，静默剥离是预期行为——即使上行携带了 seq 也不应保留
  it("EventDraft 静默剥离多余的 seq 字段（预期行为，非 bug）", () => {
    expect(EventDraft.parse(validText)).not.toHaveProperty("seq");
  });
});

describe("EventLoose / EventDraftLoose", () => {
  it("EventLoose 放行未知 type，Event 拒绝同一份数据", () => {
    const unknown = { ...validText, type: "voice_note", body: { url: "x" } };
    expect(EventLoose.parse(unknown).type).toBe("voice_note");
    expect(() => Event.parse(unknown)).toThrow();
  });

  it("EventDraftLoose 放行未知 type 且无需 seq，EventDraft 拒绝同一份数据", () => {
    const { seq, ...draft } = validText;
    const unknown = { ...draft, type: "voice_note", body: { url: "x" } };
    expect(EventDraftLoose.parse(unknown).type).toBe("voice_note");
    expect(() => EventDraft.parse(unknown)).toThrow();
  });
});
