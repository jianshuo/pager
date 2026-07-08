import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

function dir() {
  return env.DIRECTORY.get(env.DIRECTORY.idFromName("directory"));
}
async function post(path: string, body: unknown) {
  return dir().fetch(`https://do${path}`, { method: "POST", body: JSON.stringify(body) });
}

describe("DirectoryDO", () => {
  it("注册返回 userId + token，同名再注册 409", async () => {
    const r = await post("/register", { username: "jianshuo", password: "hunter2" });
    expect(r.status).toBe(200);
    const { userId, username, token } = await r.json<any>();
    expect(userId.startsWith("usr_")).toBe(true);
    expect(token.startsWith("stk_")).toBe(true);
    expect(username).toBe("jianshuo");

    const dup = await post("/register", { username: "jianshuo", password: "other1" });
    expect(dup.status).toBe(409);
  });

  it("登录：对密码发 token，错密码 401", async () => {
    await post("/register", { username: "xiaolin", password: "hunter2" });
    const ok = await post("/login", { username: "xiaolin", password: "hunter2" });
    expect(ok.status).toBe(200);
    expect((await ok.json<any>()).token.startsWith("stk_")).toBe(true);

    const bad = await post("/login", { username: "xiaolin", password: "nope" });
    expect(bad.status).toBe(401);
  });

  it("resolve：token → userId/username；无效 token → null", async () => {
    const { userId, token } = await (await post("/register", { username: "alice", password: "hunter2" })).json<any>();
    const who = await (await post("/resolve", { token })).json<any>();
    expect(who).toEqual({ userId, username: "alice" });
    expect(await (await post("/resolve", { token: "stk_nope" })).json()).toBeNull();
  });

  it("logout 后 token 失效", async () => {
    const { token } = await (await post("/register", { username: "bob", password: "hunter2" })).json<any>();
    await post("/logout", { token });
    expect(await (await post("/resolve", { token })).json()).toBeNull();
  });

  it("search：前缀命中", async () => {
    await post("/register", { username: "carol", password: "hunter2" });
    await post("/register", { username: "carla", password: "hunter2" });
    const rows = await (await dir().fetch("https://do/search?q=car")).json<any[]>();
    const names = rows.map((r) => r.username).sort();
    expect(names).toContain("carol");
    expect(names).toContain("carla");
  });
});
