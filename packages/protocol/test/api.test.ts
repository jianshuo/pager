import { describe, it, expect } from "vitest";
import {
  Username,
  RegisterRequest,
  NewGroupRequest,
  ConversationSummary,
  DeviceRegistration,
  BotSummary,
  UserSummary,
  newId,
  Event,
} from "../src/index.js";

describe("Username", () => {
  it("归一化到小写", () => {
    expect(Username.parse("AB_c")).toBe("ab_c");
  });
  it("拒绝太短", () => {
    expect(() => Username.parse("ab")).toThrow();
  });
  it("拒绝非法字符", () => {
    expect(() => Username.parse("a b!")).toThrow();
  });
});

describe("RegisterRequest", () => {
  it("接受合法输入并归一化用户名", () => {
    const r = RegisterRequest.parse({ username: "XiaoLin", password: "hunter2" });
    expect(r.username).toBe("xiaolin");
  });
  it("拒绝短密码", () => {
    expect(() => RegisterRequest.parse({ username: "xiaolin", password: "123" })).toThrow();
  });
});

describe("NewGroupRequest", () => {
  it("members 缺省为空数组", () => {
    expect(NewGroupRequest.parse({ title: "家人群" }).members).toEqual([]);
  });
  it("拒绝空标题", () => {
    expect(() => NewGroupRequest.parse({ title: "  " })).toThrow();
  });
});

describe("ConversationSummary", () => {
  it("给可选字段填默认值", () => {
    const c = ConversationSummary.parse({ id: "dm_a_b", kind: "direct" });
    expect(c.title).toBe("");
    expect(c.lastSeq).toBe(0);
  });
  it("拒绝非法 kind", () => {
    expect(() => ConversationSummary.parse({ id: "x", kind: "channel" })).toThrow();
  });
});

describe("bot 标记", () => {
  it("BotSummary 解析", () => {
    const b = BotSummary.parse({ userId: "usr_bot_claude", username: "claude", backend: "claude", displayName: "Claude" });
    expect(b.backend).toBe("claude");
  });
  it("UserSummary kind 默认 human", () => {
    expect(UserSummary.parse({ userId: "usr_1", username: "a" }).kind).toBe("human");
  });
});

describe("DeviceRegistration", () => {
  it("解析 deviceToken", () => {
    expect(DeviceRegistration.parse({ deviceToken: "abc" }).deviceToken).toBe("abc");
  });
});

describe("newId", () => {
  it("生成带前缀的唯一 id", () => {
    const a = newId("evt");
    expect(a).toMatch(/^evt_[0-9a-f-]{36}$/);
    expect(a).not.toBe(newId("evt"));
    expect(newId("cnv").startsWith("cnv_")).toBe(true);
  });
});

describe("index 汇总导出", () => {
  it("包根能拿到 Event", () => {
    expect(typeof Event.parse).toBe("function");
  });
});

import { NewBotRequest } from "../src/index.js";
describe("NewBotRequest", () => {
  it("解析建 bot 请求（用户名归一化）", () => {
    const r = NewBotRequest.parse({ name: "MyBot", machineId: "mch_x", dir: "/a" });
    expect(r.name).toBe("mybot");
    expect(r.machineId).toBe("mch_x");
  });
});
