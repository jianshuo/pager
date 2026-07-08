import { z } from "zod";

export const Role = z.enum(["user", "agent", "system"]);
export type Role = z.infer<typeof Role>;

export const StatusState = z.enum([
  "thinking",
  "running",
  "waiting_input",
  "done",
  "failed",
]);
export type StatusState = z.infer<typeof StatusState>;

export const PermissionChoice = z.enum(["allow", "deny", "allow_always"]);
export type PermissionChoice = z.infer<typeof PermissionChoice>;

export const TextBody = z.object({ markdown: z.string() });
export type TextBody = z.infer<typeof TextBody>;

export const ToolCardBody = z.object({
  tool: z.string(),
  title: z.string(),
  summary: z.string().default(""),
  detail: z.string().default(""),
  diff: z.string().optional(),
});
export type ToolCardBody = z.infer<typeof ToolCardBody>;

export const PermissionRequestBody = z.object({
  request_id: z.string(),
  tool: z.string(),
  description: z.string(),
  options: z.array(PermissionChoice).min(1),
});
export type PermissionRequestBody = z.infer<typeof PermissionRequestBody>;

export const PermissionResponseBody = z.object({
  request_id: z.string(),
  choice: PermissionChoice,
});
export type PermissionResponseBody = z.infer<typeof PermissionResponseBody>;

export const StatusBody = z.object({
  state: StatusState,
  note: z.string().optional(),
});
export type StatusBody = z.infer<typeof StatusBody>;

// 系统事件：进群/退群等中性提示，由服务端在成员变化时广播进会话时间线
export const SystemBody = z.object({ text: z.string() });
export type SystemBody = z.infer<typeof SystemBody>;

export const ErrorBody = z.object({
  message: z.string(),
  recoverable: z.boolean(),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

// seq 由 ConversationDO 分配：上行用 EventDraft（无 seq），落库/下行用 Event
const base = {
  id: z.string().startsWith("evt_"),
  // Mesh 会话 id 有两种：群 `cnv_…`、1:1 直连 `dm_<a>_<b>`（确定性）。放宽为非空字符串。
  conv: z.string().min(1),
  seq: z.number().int().nonnegative(),
  ts: z.number().int().positive(), // epoch 秒
  role: Role,
  agent: z.string().default("claude-code"),
};

const { seq: _seq, ...draftBase } = base;

const variant = <T extends string, B extends z.ZodTypeAny>(type: T, body: B) =>
  z.object({ ...base, type: z.literal(type), body });

const draftVariant = <T extends string, B extends z.ZodTypeAny>(type: T, body: B) =>
  z.object({ ...draftBase, type: z.literal(type), body });

export const Event = z.discriminatedUnion("type", [
  variant("text", TextBody),
  variant("system", SystemBody),
  variant("tool_card", ToolCardBody),
  variant("permission_request", PermissionRequestBody),
  variant("permission_response", PermissionResponseBody),
  variant("status", StatusBody),
  variant("error", ErrorBody),
]);
export type Event = z.infer<typeof Event>;

export const EventDraft = z.discriminatedUnion("type", [
  draftVariant("text", TextBody),
  draftVariant("system", SystemBody),
  draftVariant("tool_card", ToolCardBody),
  draftVariant("permission_request", PermissionRequestBody),
  draftVariant("permission_response", PermissionResponseBody),
  draftVariant("status", StatusBody),
  draftVariant("error", ErrorBody),
]);
export type EventDraft = z.infer<typeof EventDraft>;

// 中枢存储/转发用的宽松信封：envelope 严格校验，type/body 不设限——
// 新 daemon 先行加事件类型时，旧 hub 照存照转，由客户端做通用卡片降级（spec §4）
export const EventLoose = z.object({ ...base, type: z.string(), body: z.unknown() });
export type EventLoose = z.infer<typeof EventLoose>;

export const EventDraftLoose = z.object({ ...draftBase, type: z.string(), body: z.unknown() });
export type EventDraftLoose = z.infer<typeof EventDraftLoose>;
