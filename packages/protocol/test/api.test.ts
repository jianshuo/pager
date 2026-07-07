import { describe, it, expect } from "vitest";
import {
  MachineSummary,
  ConversationSummary,
  NewConversationRequest,
  NewConversationResponse,
  PermissionResponseRequest,
  DeviceRegistration,
  newId,
  Event,
} from "../src/index.js";

describe("REST DTO", () => {
  it("解析 MachineSummary", () => {
    const m = { id: "mch_mac", name: "Mac", online: true, dirs: ["/a"] };
    expect(MachineSummary.parse(m)).toEqual(m);
  });

  it("解析 ConversationSummary 并拒绝非法 state", () => {
    const c = {
      id: "cnv_1",
      machineId: "mch_mac",
      machineName: "Mac",
      dir: "/a",
      state: "running",
      lastMessage: "跑测试中…",
      lastSeq: 42,
      updatedAt: 1751780000,
    };
    expect(ConversationSummary.parse(c)).toEqual(c);
    expect(() => ConversationSummary.parse({ ...c, state: "paused" })).toThrow();
  });

  it("NewConversationRequest 拒绝空 message", () => {
    expect(() =>
      NewConversationRequest.parse({ machineId: "mch_mac", dir: "/a", message: "" })
    ).toThrow();
  });

  it("解析 PermissionResponseRequest 与 DeviceRegistration", () => {
    expect(
      PermissionResponseRequest.parse({ conv: "cnv_1", request_id: "r1", choice: "allow" }).choice
    ).toBe("allow");
    expect(DeviceRegistration.parse({ deviceToken: "abc" }).deviceToken).toBe("abc");
  });

  it("解析 NewConversationResponse 并拒绝错误前缀", () => {
    expect(NewConversationResponse.parse({ id: "cnv_1" }).id).toBe("cnv_1");
    expect(() => NewConversationResponse.parse({ id: "x_1" })).toThrow();
  });
});

describe("newId", () => {
  it("生成带前缀的唯一 id", () => {
    const a = newId("evt");
    const b = newId("evt");
    expect(a).toMatch(/^evt_[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
    expect(newId("cnv").startsWith("cnv_")).toBe(true);
    expect(newId("mch").startsWith("mch_")).toBe(true);
  });
});

describe("index 汇总导出", () => {
  it("包根能拿到 Event", () => {
    expect(typeof Event.parse).toBe("function");
  });
});
