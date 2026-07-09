import { describe, it, expect } from "vitest";
import { streamBotReply } from "../src/responder.js";

describe("streamBotReply", () => {
  it("BOT_MOCK 下产出固定回复，含最后一句用户消息", async () => {
    const env: any = { BOT_MOCK: "1" };
    let out = "";
    for await (const d of streamBotReply(env, "claude", "m", "sys", [
      { role: "user", content: "h1: 讲个笑话" },
    ])) {
      out += d;
    }
    expect(out).toContain("讲个笑话");
    expect(out.length).toBeGreaterThan(0);
  });
});
