import { query } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { newId, type EventDraft } from "@pager/protocol";
import type { AgentAdapter, RunOptions } from "./types.js";

const nowSec = () => Math.floor(Date.now() / 1000);

function draft(conv: string, type: EventDraft["type"], body: unknown, id = newId("evt")): any {
  return { id, conv, ts: nowSec(), role: "agent" as const, agent: "claude-code", type, body };
}

const statusDraft = (conv: string, state: string, note?: string) =>
  draft(conv, "status", note ? { state, note } : { state });

// 把工具调用压成一行人话标题
function toolTitle(name: string, input: any): string {
  if (name === "Bash" && typeof input?.command === "string") return input.command.slice(0, 80);
  if (typeof input?.file_path === "string") return `${name} ${input.file_path}`;
  if (typeof input?.pattern === "string") return `${name} ${input.pattern}`;
  return name;
}

function toolDetail(input: any, resultStr: string): string {
  const inputStr = JSON.stringify(input ?? {}, null, 2);
  return `输入:\n${inputStr.slice(0, 1500)}\n\n输出:\n${resultStr.slice(0, 2500)}`;
}

function resultText(block: any): string {
  const c = block?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b: any) => (typeof b?.text === "string" ? b.text : "")).join("\n");
  return "";
}

export function createClaudeCodeAdapter(queryFn: typeof query = query): AgentAdapter {
  return {
    run(opts: RunOptions) {
      const abort = new AbortController();
      const done = runLoop(opts, queryFn, abort).catch((err) => {
        opts.emit({
          kind: "event",
          event: statusDraft(opts.conv, "failed", String(err).slice(0, 300)),
        });
      });
      return { interrupt: () => abort.abort(), done };
    },
  };
}

async function runLoop(opts: RunOptions, queryFn: typeof query, abort: AbortController): Promise<void> {
  opts.emit({ kind: "event", event: statusDraft(opts.conv, "running") });

  // canUseTool 的真 SDK 签名是 (toolName, input, options)——第三参我们不用，设可选。
  const canUseTool = async (toolName: string, input: Record<string, unknown>) => {
    const request_id = `req_${randomUUID()}`;
    const req = {
      request_id,
      tool: toolName,
      description: toolTitle(toolName, input),
      options: ["allow", "deny"] as const,
    };
    opts.emit({ kind: "event", event: draft(opts.conv, "permission_request", req) });
    const choice = await opts.requestPermission({ ...req, options: ["allow", "deny"] });
    return choice === "deny"
      ? { behavior: "deny" as const, message: "用户在 Pager 上拒绝了此操作" }
      : { behavior: "allow" as const, updatedInput: input };
  };

  const q = queryFn({
    prompt: opts.prompt,
    options: {
      cwd: opts.dir,
      resume: opts.agentSessionId,
      abortController: abort,
      includePartialMessages: true,
      permissionMode: opts.permissionMode as any,
      canUseTool,
    } as any,
  });

  let textId: string | null = null;
  let textBuf = "";
  let lastPatch = 0;
  const pendingTools = new Map<string, { name: string; input: any }>();

  const flushText = () => {
    if (textId && textBuf) opts.emit({ kind: "patch", conv: opts.conv, eventId: textId, markdown: textBuf });
  };

  for await (const msg of q as AsyncIterable<any>) {
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init" && msg.session_id)
          opts.emit({ kind: "session", conv: opts.conv, agentSessionId: msg.session_id });
        break;

      case "stream_event": {
        const ev = msg.event;
        if (ev?.type === "content_block_start" && ev.content_block?.type === "text") {
          textId = newId("evt");
          textBuf = "";
          lastPatch = 0;
          opts.emit({ kind: "event", event: draft(opts.conv, "text", { markdown: "" }, textId) });
        } else if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && textId) {
          textBuf += ev.delta.text;
          if (Date.now() - lastPatch >= 400) {
            lastPatch = Date.now();
            flushText();
          }
        } else if (ev?.type === "content_block_stop" && textId) {
          flushText();
          textId = null;
        }
        break;
      }

      case "assistant": {
        for (const block of msg.message?.content ?? []) {
          if (block.type === "tool_use") pendingTools.set(block.id, { name: block.name, input: block.input });
        }
        break;
      }

      case "user": {
        const content = msg.message?.content;
        if (!Array.isArray(content)) break;
        for (const block of content) {
          if (block.type === "tool_result") {
            const t = pendingTools.get(block.tool_use_id);
            if (!t) continue;
            pendingTools.delete(block.tool_use_id);
            opts.emit({
              kind: "event",
              event: draft(opts.conv, "tool_card", {
                tool: t.name,
                title: toolTitle(t.name, t.input),
                summary: "",
                detail: toolDetail(t.input, resultText(block)),
              }),
            });
          }
        }
        break;
      }

      case "result": {
        flushText();
        const failed = msg.is_error === true || (typeof msg.subtype === "string" && msg.subtype !== "success");
        opts.emit({
          kind: "event",
          event: statusDraft(opts.conv, failed ? "failed" : "done", failed ? String(msg.subtype ?? "") : undefined),
        });
        break;
      }
    }
  }
}
