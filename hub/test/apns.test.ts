import { describe, it, expect } from "vitest";
import { apnsJwt, sendApns, pushPlanFor } from "../src/apns.js";

// 生成一把测试用 P-256 私钥，导出成 PEM（PKCS8）
async function testKey() {
  // @cloudflare/workers-types/2023-07-01 类型化 generateKey 恒为 CryptoKey | CryptoKeyPair
  // 联合类型（不像 lib.dom 按算法重载区分），故此处需断言；不影响运行时。
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pkcs8 = (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer;
  const b64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8)));
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----`;
  return { pem, publicKey: pair.publicKey };
}

function b64urlToBytes(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

describe("apnsJwt", () => {
  it("生成可验签的 ES256 JWT，头与 claims 正确", async () => {
    const { pem, publicKey } = await testKey();
    const jwt = await apnsJwt({ teamId: "TEAM123456", keyId: "KEY1234567", p8Pem: pem }, 1751780000);
    const [h, c, sig] = jwt.split(".");
    expect(JSON.parse(atob(h.replace(/-/g, "+").replace(/_/g, "/")))).toEqual({
      alg: "ES256",
      kid: "KEY1234567",
    });
    expect(JSON.parse(atob(c.replace(/-/g, "+").replace(/_/g, "/")))).toEqual({
      iss: "TEAM123456",
      iat: 1751780000,
    });
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      b64urlToBytes(sig),
      new TextEncoder().encode(`${h}.${c}`)
    );
    expect(ok).toBe(true);
  });
});

describe("sendApns", () => {
  it("请求打到正确 host，头与 body 正确；410 → gone", async () => {
    const { pem } = await testKey();
    const cfg = { teamId: "T", keyId: "K", p8Pem: pem, bundleId: "dev.jianshuo.pager", env: "sandbox" };
    const seen: Request[] = [];
    const fake = async (req: Request) => {
      seen.push(req.clone() as Request);
      return new Response(null, { status: seen.length === 1 ? 200 : 410 });
    };
    const r1 = await sendApns(
      cfg,
      {
        deviceToken: "devtok",
        title: "需要批准 · Mac",
        body: "运行 rm -rf build/",
        priority: 10,
        category: "PERMISSION_REQUEST",
        threadId: "cnv_1",
        payload: { conv: "cnv_1", request_id: "req_1" },
      },
      fake as unknown as typeof fetch
    );
    expect(r1).toEqual({ ok: true, status: 200, gone: false });
    const req = seen[0];
    expect(new URL(req.url).host).toBe("api.sandbox.push.apple.com");
    expect(new URL(req.url).pathname).toBe("/3/device/devtok");
    expect(req.headers.get("apns-topic")).toBe("dev.jianshuo.pager");
    expect(req.headers.get("apns-priority")).toBe("10");
    expect(req.headers.get("apns-push-type")).toBe("alert");
    expect(req.headers.get("authorization")).toMatch(/^bearer .+/);
    const body = await req.json<any>();
    expect(body.aps.alert).toEqual({ title: "需要批准 · Mac", body: "运行 rm -rf build/" });
    expect(body.aps.category).toBe("PERMISSION_REQUEST");
    expect(body.aps["thread-id"]).toBe("cnv_1");
    expect(body.conv).toBe("cnv_1");
    expect(body.request_id).toBe("req_1");

    const r2 = await sendApns(cfg, { deviceToken: "devtok", title: "t", body: "b", priority: 5 }, fake as any);
    expect(r2.gone).toBe(true);
  });
});

describe("pushPlanFor（Mesh：只推真人文本消息）", () => {
  const base = { id: "evt_1", conv: "cnv_1", seq: 1, ts: 1, role: "user", agent: "claude-code" } as const;

  it("text → 高优先级，title 为传入名、body 为正文", () => {
    const plan = pushPlanFor({ ...base, type: "text", body: { markdown: "你好呀" } } as any, { title: "小林" });
    expect(plan).toEqual({ title: "小林", body: "你好呀", priority: 10 });
  });

  it("title 空时回退「新消息」", () => {
    expect(pushPlanFor({ ...base, type: "text", body: { markdown: "hi" } } as any, { title: "" })?.title).toBe("新消息");
  });

  it("system/status/未知类型不推", () => {
    expect(pushPlanFor({ ...base, type: "system", body: { text: "进群" } } as any, { title: "群" })).toBeNull();
    expect(pushPlanFor({ ...base, type: "status", body: { state: "done" } } as any, { title: "x" })).toBeNull();
    expect(pushPlanFor({ ...base, type: "voice_note", body: {} } as any, { title: "x" })).toBeNull();
  });
});
