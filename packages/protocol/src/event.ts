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

export const ErrorBody = z.object({
  message: z.string(),
  recoverable: z.boolean(),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

// seq 由 ConversationDO 分配：上行用 EventDraft（无 seq），落库/下行用 Event
const base = {
  id: z.string().startsWith("evt_"),
  conv: z.string().startsWith("cnv_"),
  seq: z.number().int().nonnegative(),
  ts: z.number().int().positive(),
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
  variant("tool_card", ToolCardBody),
  variant("permission_request", PermissionRequestBody),
  variant("permission_response", PermissionResponseBody),
  variant("status", StatusBody),
  variant("error", ErrorBody),
]);
export type Event = z.infer<typeof Event>;

export const EventDraft = z.discriminatedUnion("type", [
  draftVariant("text", TextBody),
  draftVariant("tool_card", ToolCardBody),
  draftVariant("permission_request", PermissionRequestBody),
  draftVariant("permission_response", PermissionResponseBody),
  draftVariant("status", StatusBody),
  draftVariant("error", ErrorBody),
]);
export type EventDraft = z.infer<typeof EventDraft>;
