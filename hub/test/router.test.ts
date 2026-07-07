import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("router", () => {
  it("health 免认证", async () => {
    const res = await SELF.fetch("https://hub/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("无 token 一律 401", async () => {
    expect((await SELF.fetch("https://hub/api/conversations")).status).toBe(401);
    expect((await SELF.fetch("https://hub/ws/client")).status).toBe(401);
  });

  it("daemon token 错误 401", async () => {
    const res = await SELF.fetch("https://hub/ws/daemon?machine=mch_x", {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(res.status).toBe(401);
  });

  it("daemon 缺 machine 参数 400", async () => {
    const res = await SELF.fetch("https://hub/ws/daemon", {
      headers: { Authorization: "Bearer test-daemon-token" },
    });
    expect(res.status).toBe(400);
  });

  it("认证通过但未知路径 404", async () => {
    const res = await SELF.fetch("https://hub/nope", {
      headers: { Authorization: "Bearer test-client-token" },
    });
    expect(res.status).toBe(404);
  });
});
