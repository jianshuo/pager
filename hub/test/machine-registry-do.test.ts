import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

function reg() {
  return env.MACHINEREG.get(env.MACHINEREG.idFromName("registry"));
}

describe("MachineRegistryDO", () => {
  it("upsert 在线机器 → /machines 列出；下线后 online=false", async () => {
    await reg().fetch("https://do/upsert", {
      method: "POST",
      body: JSON.stringify({ id: "mch_reg1", name: "建硕的 Mac", dirs: ["/Users/jianshuo/code"], online: true }),
    });
    let list = await (await reg().fetch("https://do/machines")).json<any[]>();
    const m = list.find((x) => x.id === "mch_reg1");
    expect(m).toMatchObject({ name: "建硕的 Mac", online: true });
    expect(m.dirs).toEqual(["/Users/jianshuo/code"]);

    await reg().fetch("https://do/upsert", {
      method: "POST",
      body: JSON.stringify({ id: "mch_reg1", name: "建硕的 Mac", dirs: ["/Users/jianshuo/code"], online: false }),
    });
    list = await (await reg().fetch("https://do/machines")).json<any[]>();
    expect(list.find((x) => x.id === "mch_reg1").online).toBe(false);
  });
});
