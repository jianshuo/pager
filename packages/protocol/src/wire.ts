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
  proto: z.number().int().positive(),
});
export type DaemonHello = z.infer<typeof DaemonHello>;

export const DaemonEvent = z.object({
  kind: z.literal("event"),
  event: EventDraft,
});
export type DaemonEvent = z.infer<typeof DaemonEvent>;

// 流式增量：整段替换 eventId 对应 text 事件的 markdown（幂等，丢一条不碎）
export const DaemonPatch = z.object({
  kind: z.literal("patch"),
  conv: z.string(),
  eventId: z.string(),
  markdown: z.string(),
});
export type DaemonPatch = z.infer<typeof DaemonPatch>;

// 会话与 agent session 绑定（resume 用），任务启动成功后上报
export const DaemonSession = z.object({
  kind: z.literal("session"),
  conv: z.string(),
  agentSessionId: z.string(),
});
export type DaemonSession = z.infer<typeof DaemonSession>;

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
export type HubTask = z.infer<typeof HubTask>;

export const HubUserEvent = z.object({
  kind: z.literal("user_event"), // 追加消息 / permission_response
  conv: z.string(),
  event: Event,
});
export type HubUserEvent = z.infer<typeof HubUserEvent>;

export const HubInterrupt = z.object({
  kind: z.literal("interrupt"),
  conv: z.string(),
});
export type HubInterrupt = z.infer<typeof HubInterrupt>;

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
export type ClientSubscribe = z.infer<typeof ClientSubscribe>;

export const ClientSend = z.object({
  kind: z.literal("send"),
  conv: z.string(),
  event: EventDraft, // text 或 permission_response
});
export type ClientSend = z.infer<typeof ClientSend>;

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
export type HubEvent = z.infer<typeof HubEvent>;

export const HubPatch = z.object({
  kind: z.literal("patch"),
  conv: z.string(),
  eventId: z.string(),
  markdown: z.string(),
});
export type HubPatch = z.infer<typeof HubPatch>;

// 机器上下线广播（多设备场景下客户端刷新在线态用）
export const HubMachineStatus = z.object({
  kind: z.literal("machine_status"),
  machine: MachineInfo,
  online: z.boolean(),
});
export type HubMachineStatus = z.infer<typeof HubMachineStatus>;

export const HubToClient = z.discriminatedUnion("kind", [
  HubEvent,
  HubPatch,
  HubMachineStatus,
]);
export type HubToClient = z.infer<typeof HubToClient>;
