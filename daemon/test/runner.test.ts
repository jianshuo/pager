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

function make(cfg: Partial<{ maxConcurrent: number; permissionTimeoutSec: number }> = {}) {
  const { adapter, runs } = fakeAdapter();
  const sent: any[] = [];
  const store = makeStore();
  const runner = new Runner(
    { maxConcurrent: cfg.maxConcurrent ?? 2, permissionTimeoutSec: cfg.permissionTimeoutSec ?? 3600, permissionMode: "default" },
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
});
