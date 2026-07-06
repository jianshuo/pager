import { describe, it, expect } from "vitest";
import {
  DaemonToHub,
  HubToDaemon,
  ClientToHub,
  HubToClient,
} from "../src/wire.js";

const draftText = {
  id: "evt_1",
  conv: "cnv_1",
  ts: 1751780000,
  role: "agent",
  agent: "claude-code",
  type: "text",
  body: { markdown: "hi" },
};

const sealedText = { ...draftText, seq: 7, role: "user" };

describe("DaemonToHub", () => {
  it("解析 hello", () => {
    const msg = {
      kind: "hello",
      machine: { id: "mch_mac", name: "建硕的 Mac" },
      dirs: ["/Users/jianshuo/code/pager"],
      maxConcurrent: 4,
    };
    expect(DaemonToHub.parse(msg).kind).toBe("hello");
  });

  it("解析 event（携带 EventDraft，无 seq）", () => {
    expect(DaemonToHub.parse({ kind: "event", event: draftText }).kind).toBe("event");
  });

  it("拒绝 event 携带已盖 seq 的事件之外的脏数据", () => {
    expect(() =>
      DaemonToHub.parse({ kind: "event", event: { ...draftText, type: "nope" } })
    ).toThrow();
  });

  it("解析 patch 与 session", () => {
    expect(
      DaemonToHub.parse({ kind: "patch", conv: "cnv_1", eventId: "evt_1", markdown: "hi!" }).kind
    ).toBe("patch");
    expect(
      DaemonToHub.parse({ kind: "session", conv: "cnv_1", agentSessionId: "s-123" }).kind
    ).toBe("session");
  });
});

describe("HubToDaemon", () => {
  it("解析 task（event 必须已盖 seq）", () => {
    const msg = {
      kind: "task",
      conv: "cnv_1",
      dir: "/Users/jianshuo/code/pager",
      agent: "claude-code",
      event: sealedText,
    };
    expect(HubToDaemon.parse(msg).kind).toBe("task");
  });

  it("task 的 event 缺 seq 应报错", () => {
    const msg = {
      kind: "task",
      conv: "cnv_1",
      dir: "/x",
      agent: "claude-code",
      event: draftText,
    };
    expect(() => HubToDaemon.parse(msg)).toThrow();
  });

  it("解析 user_event 与 interrupt", () => {
    expect(
      HubToDaemon.parse({ kind: "user_event", conv: "cnv_1", event: sealedText }).kind
    ).toBe("user_event");
    expect(HubToDaemon.parse({ kind: "interrupt", conv: "cnv_1" }).kind).toBe("interrupt");
  });
});

describe("ClientToHub", () => {
  it("解析 subscribe（afterSeq 增量补齐）", () => {
    expect(
      ClientToHub.parse({ kind: "subscribe", conv: "cnv_1", afterSeq: 0 }).kind
    ).toBe("subscribe");
  });

  it("解析 send（EventDraft）", () => {
    expect(
      ClientToHub.parse({ kind: "send", conv: "cnv_1", event: { ...draftText, role: "user" } }).kind
    ).toBe("send");
  });
});

describe("HubToClient", () => {
  it("解析 event 与 patch", () => {
    expect(HubToClient.parse({ kind: "event", event: sealedText }).kind).toBe("event");
    expect(
      HubToClient.parse({ kind: "patch", conv: "cnv_1", eventId: "evt_1", markdown: "x" }).kind
    ).toBe("patch");
  });
});
