import { z } from "zod";
import { Event, EventDraft } from "./event.js";

// ---------- daemon → hub ----------

export const MachineInfo = z.object({
  id: z.string().startsWith("mch_"),
  name: z.string(),
});
export type MachineInfo = z.infer<typeof MachineInfo>;

export const DaemonHello = z.object({
  kind: z.literal("hello"),
  machine: MachineInfo,
  dirs: z.array(z.string()),
  maxConcurrent: z.number().int().positive(),
});

export const DaemonEvent = z.object({
  kind: z.literal("event"),
  event: EventDraft,
});

// 流式增量：整段替换 eventId 对应 text 事件的 markdown（幂等，丢一条不碎）
export const DaemonPatch = z.object({
  kind: z.literal("patch"),
  conv: z.string(),
  eventId: z.string(),
  markdown: z.string(),
});

// 会话与 agent session 绑定（resume 用），任务启动成功后上报
export const DaemonSession = z.object({
  kind: z.literal("session"),
  conv: z.string(),
  agentSessionId: z.string(),
});

export const DaemonToHub = z.discriminatedUnion("kind", [
  DaemonHello,
  DaemonEvent,
  DaemonPatch,
  DaemonSession,
]);
export type DaemonToHub = z.infer<typeof DaemonToHub>;

// ---------- hub → daemon ----------

export const HubTask = z.object({
  kind: z.literal("task"),
  conv: z.string(),
  dir: z.string(),
  agent: z.string(), // "claude-code"，为多 adapter 留口
  agentSessionId: z.string().optional(), // 有则 resume，无则新起
  event: Event, // 用户 text 事件（已盖 seq）
});

export const HubUserEvent = z.object({
  kind: z.literal("user_event"), // 追加消息 / permission_response
  conv: z.string(),
  event: Event,
});

export const HubInterrupt = z.object({
  kind: z.literal("interrupt"),
  conv: z.string(),
});

export const HubToDaemon = z.discriminatedUnion("kind", [
  HubTask,
  HubUserEvent,
  HubInterrupt,
]);
export type HubToDaemon = z.infer<typeof HubToDaemon>;

// ---------- client → hub ----------

export const ClientSubscribe = z.object({
  kind: z.literal("subscribe"),
  conv: z.string(),
  afterSeq: z.number().int().nonnegative(),
});

export const ClientSend = z.object({
  kind: z.literal("send"),
  conv: z.string(),
  event: EventDraft, // text 或 permission_response
});

export const ClientToHub = z.discriminatedUnion("kind", [
  ClientSubscribe,
  ClientSend,
]);
export type ClientToHub = z.infer<typeof ClientToHub>;

// ---------- hub → client ----------

export const HubEvent = z.object({
  kind: z.literal("event"),
  event: Event,
});

export const HubPatch = z.object({
  kind: z.literal("patch"),
  conv: z.string(),
  eventId: z.string(),
  markdown: z.string(),
});

export const HubToClient = z.discriminatedUnion("kind", [HubEvent, HubPatch]);
export type HubToClient = z.infer<typeof HubToClient>;
