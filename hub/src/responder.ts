import type { Env } from "./env.js";

// 一轮对话的消息（喂给 LLM）。role: user=对方/群里其他人，assistant=这个 bot 自己过往。
export type ChatMsg = { role: "user" | "assistant"; content: string };

// 流式产出 bot 回复的增量文本。env.BOT_MOCK 存在时产固定回复（测试用，不真调 API）。
export async function* streamBotReply(
  env: Env,
  backend: "claude" | "chatgpt",
  model: string,
  system: string,
  messages: ChatMsg[]
): AsyncGenerator<string> {
  if (env.BOT_MOCK) {
    const last = messages.filter((m) => m.role === "user").slice(-1)[0]?.content ?? "";
    yield "（mock）收到：";
    yield last;
    return;
  }
  if (backend === "claude") {
    yield* streamAnthropic(env, model, system, messages);
  } else {
    yield* streamOpenAI(env, model, system, messages);
  }
}

async function* streamAnthropic(env: Env, model: string, system: string, messages: ChatMsg[]): AsyncGenerator<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY ?? "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system,
      stream: true,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    }),
  });
  yield* sseText(res, (j) => (j.type === "content_block_delta" ? (j.delta?.text ?? "") : ""));
}

async function* streamOpenAI(env: Env, model: string, system: string, messages: ChatMsg[]): AsyncGenerator<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.OPENAI_API_KEY ?? ""}` },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [{ role: "system", content: system }, ...messages],
    }),
  });
  yield* sseText(res, (j) => j.choices?.[0]?.delta?.content ?? "");
}

// 通用 SSE：逐行取 `data:`，JSON.parse 后用 pick 抽增量文本。非 2xx 抛错。
async function* sseText(res: Response, pick: (j: any) => string): AsyncGenerator<string> {
  if (!res.ok) throw new Error(`LLM ${res.status}`);
  if (!res.body) return;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        const t = pick(JSON.parse(data));
        if (t) yield t;
      } catch {
        /* 非 JSON 心跳行，跳过 */
      }
    }
  }
}
