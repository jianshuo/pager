import type { EventLoose } from "@pager/protocol";

export interface ApnsConfig {
  teamId: string;
  keyId: string;
  p8Pem: string;
  bundleId: string;
  env: string; // "sandbox" | "production"
}

export interface ApnsMessage {
  deviceToken: string;
  title: string;
  body: string;
  priority: 5 | 10;
  category?: string;
  threadId?: string;
  payload?: Record<string, unknown>;
}

export interface PushPlan {
  title: string;
  body: string;
  priority: 5 | 10;
  category?: string;
  request_id?: string;
}

const STATE_ZH: Record<string, string> = {
  done: "完成",
  failed: "失败",
  waiting_input: "等你回复",
};

// 纯函数推送裁决——spec §1 推送规则
// Mesh：只推真人文本消息（system/status 等不打扰）。title 为群名或发送者名，body 为消息正文。
export function pushPlanFor(event: EventLoose, meta: { title: string }): PushPlan | null {
  const b = event.body as Record<string, unknown> | undefined;
  if (event.type === "text" && typeof b?.markdown === "string") {
    return {
      title: meta.title || "新消息",
      body: b.markdown.slice(0, 120),
      priority: 10,
    };
  }
  return null;
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlJson(obj: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer;
}

export async function apnsJwt(
  cfg: { teamId: string; keyId: string; p8Pem: string },
  nowSec: number
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(cfg.p8Pem),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const signing = `${b64urlJson({ alg: "ES256", kid: cfg.keyId })}.${b64urlJson({ iss: cfg.teamId, iat: nowSec })}`;
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signing)
  );
  return `${signing}.${b64url(new Uint8Array(sig))}`;
}

export async function sendApns(
  cfg: ApnsConfig,
  msg: ApnsMessage,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: boolean; status: number; gone: boolean }> {
  const host = cfg.env === "production" ? "api.push.apple.com" : "api.sandbox.push.apple.com";
  const jwt = await apnsJwt(cfg, Math.floor(Date.now() / 1000));
  const aps: Record<string, unknown> = { alert: { title: msg.title, body: msg.body } };
  if (msg.category) aps.category = msg.category;
  if (msg.threadId) aps["thread-id"] = msg.threadId;
  const res = await fetchImpl(
    new Request(`https://${host}/3/device/${msg.deviceToken}`, {
      method: "POST",
      headers: {
        authorization: `bearer ${jwt}`,
        "apns-topic": cfg.bundleId,
        "apns-push-type": "alert",
        "apns-priority": String(msg.priority),
      },
      body: JSON.stringify({ aps, ...(msg.payload ?? {}) }),
    })
  );
  return { ok: res.ok, status: res.status, gone: res.status === 410 };
}
