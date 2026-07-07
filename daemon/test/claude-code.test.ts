import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createClaudeCodeAdapter } from "../src/adapters/claude-code.js";

function fixtureMessages(): any[] {
  const raw = readFileSync(new URL("./fixtures/claude-events.jsonl", import.meta.url), "utf8");
  return raw.trim().split("\n").map((l) => JSON.parse(l));
}

function fakeQuery(messages: any[]) {
  return () => (async function* () { for (const m of messages) yield m; })();
}

async function run(
  messages: any[],
  over: Partial<Parameters<ReturnType<typeof createClaudeCodeAdapter>["run"]>[0]> = {},
) {
  const emitted: any[] = [];
  const adapter = createClaudeCodeAdapter(fakeQuery(messages) as any);
  const handle = adapter.run({
    conv: "cnv_t",
    dir: "/tmp",
    prompt: "test",
    permissionMode: "default",
    emit: (m) => emitted.push(m),
    requestPermission: async () => "allow",
    ...over,
  });
  await handle.done;
  return emitted;
}

describe("claude-code adapter（fixture 回放）", () => {
  it("翻译不变量：session → running → 文本+最终patch → done", async () => {
    const emitted = await run(fixtureMessages());

    const session = emitted.find((m) => m.kind === "session");
    expect(session?.agentSessionId).toBeTruthy();

    const statuses = emitted
      .filter((m) => m.kind === "event" && m.event.type === "status")
      .map((m) => m.event.body.state);
    expect(statuses[0]).toBe("running");
    expect(statuses[statuses.length - 1]).toBe("done");

    const textEvents = emitted.filter((m) => m.kind === "event" && m.event.type === "text");
    expect(textEvents.length).toBeGreaterThan(0);
    const patches = emitted.filter((m) => m.kind === "patch");
    expect(patches.length).toBeGreaterThan(0);
    expect(patches[patches.length - 1].markdown.length).toBeGreaterThan(0);

    // fixture 里有写文件动作 → 应有 tool_card
    const cards = emitted.filter((m) => m.kind === "event" && m.event.type === "tool_card");
    expect(cards.length).toBeGreaterThan(0);
    expect(cards[0].event.body.title.length).toBeGreaterThan(0);

    // 所有上行事件 conv 正确且无 seq
    for (const m of emitted) {
      if (m.kind === "event") {
        expect(m.event.conv).toBe("cnv_t");
        expect(m.event).not.toHaveProperty("seq");
      }
    }
  });

  it("canUseTool 桥：deny 返回 SDK deny 且发 permission_request", async () => {
    const emitted: any[] = [];
    let sdkDecision: any = null;
    const adapter = createClaudeCodeAdapter(((args: any) =>
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "s-perm" };
        sdkDecision = await args.options.canUseTool("Bash", { command: "rm -rf /tmp/x" });
        yield { type: "result", subtype: "success", is_error: false };
      })()) as any);
    const handle = adapter.run({
      conv: "cnv_p",
      dir: "/tmp",
      prompt: "t",
      permissionMode: "default",
      emit: (m) => emitted.push(m),
      requestPermission: async (req) => {
        expect(req.tool).toBe("Bash");
        expect(req.request_id.startsWith("req_")).toBe(true);
        expect(req.description).toContain("rm -rf");
        return "deny";
      },
    });
    await handle.done;
    expect(sdkDecision.behavior).toBe("deny");
    const pr = emitted.find((m) => m.kind === "event" && m.event.type === "permission_request");
    expect(pr).toBeTruthy();
  });

  it("SDK 异常 → status failed（不 throw 出去）", async () => {
    const adapter = createClaudeCodeAdapter((() =>
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "s-err" };
        throw new Error("boom");
      })()) as any);
    const emitted: any[] = [];
    const handle = adapter.run({
      conv: "cnv_e",
      dir: "/tmp",
      prompt: "t",
      permissionMode: "default",
      emit: (m) => emitted.push(m),
      requestPermission: async () => "allow",
    });
    await handle.done; // 不应 reject
    const last = emitted.filter((m) => m.kind === "event" && m.event.type === "status").pop();
    expect(last.event.body.state).toBe("failed");
  });
});
