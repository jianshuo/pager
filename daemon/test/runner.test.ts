import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runner } from "../src/runner.js";
import { SessionStore } from "../src/state.js";
import type { AgentAdapter, RunOptions } from "../src/adapters/types.js";

function makeStore() {
  const s = new SessionStore(join(mkdtempSync(join(tmpdir(), "pager-run-")), "state.json"));
  s.load();
  return s;
}

// 可手动完成的假 adapter
function fakeAdapter() {
  const runs: Array<{ opts: RunOptions; finish: () => void; interrupted: boolean }> = [];
  const adapter: AgentAdapter = {
    run(opts) {
      let resolve!: () => void;
      const done = new Promise<void>((r) => (resolve = r));
      const rec = { opts, finish: resolve, interrupted: false };
      runs.push(rec);
      return { interrupt: () => { rec.interrupted = true; resolve(); }, done };
    },
  };
  return { adapter, runs };
}

const textEvent = (conv: string, md: string) => ({
  id: "evt_u", conv, seq: 1, ts: 1, role: "user", agent: "claude-code",
  type: "text", body: { markdown: md },
});

const task = (conv: string, dir = "/proj") => ({
  kind: "task" as const, conv, dir, agent: "claude-code", event: textEvent(conv, "do it"),
});

function make(cfg: Partial<{ maxConcurrent: number; permissionTimeoutSec: number; dirs: string[] }> = {}) {
  const { adapter, runs } = fakeAdapter();
  const sent: any[] = [];
  const store = makeStore();
  const runner = new Runner(
    {
      maxConcurrent: cfg.maxConcurrent ?? 2,
      permissionTimeoutSec: cfg.permissionTimeoutSec ?? 3600,
      permissionMode: "default",
      dirs: cfg.dirs ?? ["/proj"],
    },
    adapter, store, (m) => sent.push(m)
  );
  return { runner, runs, sent, store };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

describe("Runner", () => {
  it("task 起跑并记 dir；结束后释放并发位", async () => {
    const { runner, runs, store } = make();
    runner.handle(task("cnv_1"));
    await tick();
    expect(runs.length).toBe(1);
    expect(runs[0].opts.prompt).toBe("do it");
    expect(store.get("cnv_1")?.dir).toBe("/proj");
    runs[0].finish();
    await tick();
  });

  it("并发闸：第 3 个 task 排队并发 thinking 状态，空位后起跑", async () => {
    const { runner, runs, sent } = make({ maxConcurrent: 2 });
    runner.handle(task("cnv_1"));
    runner.handle(task("cnv_2"));
    runner.handle(task("cnv_3"));
    await tick();
    expect(runs.length).toBe(2);
    const queued = sent.find((m) => m.kind === "event" && m.event.conv === "cnv_3" && m.event.type === "status");
    expect(queued.event.body.state).toBe("thinking");
    runs[0].finish();
    await tick();
    expect(runs.length).toBe(3);
    expect(runs[2].opts.conv).toBe("cnv_3");
  });

  it("追加消息：conv 忙则排队跑完自动续（带 resume），空闲直接起跑", async () => {
    const { runner, runs, store } = make();
    runner.handle(task("cnv_1"));
    await tick();
    store.set("cnv_1", { agentSessionId: "s-1" });
    runner.handle({ kind: "user_event", conv: "cnv_1", event: textEvent("cnv_1", "追加") as any });
    await tick();
    expect(runs.length).toBe(1); // 还在忙，先排队
    runs[0].finish();
    await tick();
    expect(runs.length).toBe(2);
    expect(runs[1].opts.prompt).toBe("追加");
    expect(runs[1].opts.agentSessionId).toBe("s-1");
  });

  it("permission_response 解析等待中的权限；超时自动 deny", async () => {
    vi.useFakeTimers();
    const { runner, runs, sent } = make({ permissionTimeoutSec: 5 });
    runner.handle(task("cnv_1"));
    await vi.advanceTimersByTimeAsync(10);

    // adapter 发起权限请求
    const p1 = runs[0].opts.requestPermission({ request_id: "req_a", tool: "Bash", description: "x", options: ["allow", "deny"] });
    runner.handle({
      kind: "user_event", conv: "cnv_1",
      event: { ...textEvent("cnv_1", ""), type: "permission_response", body: { request_id: "req_a", choice: "allow" } } as any,
    });
    await expect(p1).resolves.toBe("allow");

    // 第二个请求超时
    const p2 = runs[0].opts.requestPermission({ request_id: "req_b", tool: "Bash", description: "y", options: ["allow", "deny"] });
    await vi.advanceTimersByTimeAsync(5_100);
    await expect(p2).resolves.toBe("deny");
    const note = sent.find((m) => m.kind === "event" && m.event.type === "status" && m.event.body.note?.includes("超时"));
    expect(note).toBeTruthy();
    vi.useRealTimers();
  });

  it("interrupt 只打断该 conv；未知 conv 的消息容忍", async () => {
    const { runner, runs } = make();
    runner.handle(task("cnv_1"));
    runner.handle(task("cnv_2"));
    await tick();
    runner.handle({ kind: "interrupt", conv: "cnv_1" });
    expect(runs[0].interrupted).toBe(true);
    expect(runs[1].interrupted).toBe(false);
    runner.handle({ kind: "interrupt", conv: "cnv_ghost" }); // 不炸
    runner.handle({ kind: "user_event", conv: "cnv_ghost", event: textEvent("cnv_ghost", "?") as any }); // 无 dir，丢弃不炸
  });

  it("排队中（尚未起跑）的 conv 来追加消息：起跑时只跑一次，追加作为续跑，不产生第二条并发", async () => {
    const { runner, runs } = make({ maxConcurrent: 1 });
    runner.handle(task("cnv_1")); // 占住唯一并发位
    runner.handle(task("cnv_2")); // 进 startQueue，此时没有 running 的 ConvRuntime
    await tick();
    expect(runs.length).toBe(1);

    // cnv_2 还在排队时又来一条追加消息——老代码会误判为"未在跑"直接再起一条并发
    runner.handle({ kind: "user_event", conv: "cnv_2", event: textEvent("cnv_2", "追加X") as any });
    await tick();
    expect(runs.length).toBe(1); // 追加消息不应立刻产生第二条并发跑

    runs[0].finish(); // 释放并发位，cnv_2 该起跑了
    await tick();
    expect(runs.length).toBe(2);
    expect(runs[1].opts.conv).toBe("cnv_2");
    expect(runs[1].opts.prompt).toBe("do it"); // 先跑原始 task，不是追加的那条

    runs[1].finish(); // cnv_2 第一次运行结束 → 续跑追加消息
    await tick();
    expect(runs.length).toBe(3);
    expect(runs[2].opts.conv).toBe("cnv_2");
    expect(runs[2].opts.prompt).toBe("追加X");
  });

  it("同一 conv 收到重复 task（仍在跑）：排队续跑，不产生第二条并发", async () => {
    const { runner, runs } = make({ maxConcurrent: 2 });
    runner.handle(task("cnv_1"));
    await tick();
    expect(runs.length).toBe(1);

    runner.handle(task("cnv_1")); // 重复 task，同一 conv 仍在跑
    await tick();
    expect(runs.length).toBe(1); // 没有多起一条并发（active 仍占 1 个位）

    runs[0].finish();
    await tick();
    expect(runs.length).toBe(2); // 结束后续跑那条排队的重复 task
    expect(runs[1].opts.conv).toBe("cnv_1");
  });

  it("dir 不在白名单：daemon 自校验拒绝，不起跑，发 failed 状态", async () => {
    const { runner, runs, sent } = make({ dirs: ["/proj"] });
    runner.handle(task("cnv_x", "/evil"));
    await tick();
    expect(runs.length).toBe(0);
    const failed = sent.find((m) => m.kind === "event" && m.event.conv === "cnv_x" && m.event.type === "status");
    expect(failed?.event.body.state).toBe("failed");
    expect(failed?.event.body.note).toContain("/evil");
  });

  it("interrupt 清掉该 conv 挂起的权限等待：立即 deny，超时计时器不再迟发状态", async () => {
    vi.useFakeTimers();
    const { runner, runs, sent } = make({ permissionTimeoutSec: 5 });
    runner.handle(task("cnv_1"));
    await vi.advanceTimersByTimeAsync(10);

    const p = runs[0].opts.requestPermission({ request_id: "req_z", tool: "Bash", description: "x", options: ["allow", "deny"] });
    runner.handle({ kind: "interrupt", conv: "cnv_1" });
    await expect(p).resolves.toBe("deny");

    const before = sent.length;
    await vi.advanceTimersByTimeAsync(5_100); // 越过原本的超时窗口
    const lateTimeout = sent
      .slice(before)
      .find((m) => m.kind === "event" && m.event.type === "status" && m.event.body.note?.includes("超时"));
    expect(lateTimeout).toBeUndefined();
    vi.useRealTimers();
  });
});
