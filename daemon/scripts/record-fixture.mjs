// 用真 SDK 在临时目录跑一个小任务，把消息流录成 JSONL（提交进库做回放测试）。
// 用法：node daemon/scripts/record-fixture.mjs
// 本机已登录 Claude Code，SDK 用本地订阅凭证——不要设置任何 API key。
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "pager-fixture-"));
const lines = [];
const q = query({
  prompt: "把 1+1 的结果写进 answer.txt，然后简短说明你做了什么。",
  options: {
    cwd: dir,
    includePartialMessages: true,
    permissionMode: "acceptEdits",
    maxTurns: 10,
  },
});
for await (const msg of q) {
  lines.push(JSON.stringify(msg));
  console.error(msg.type + (msg.subtype ? `:${msg.subtype}` : ""));
}
const out = new URL("../test/fixtures/claude-events.jsonl", import.meta.url).pathname;
writeFileSync(out, lines.join("\n") + "\n");
console.log(`recorded ${lines.length} messages → ${out}`);
