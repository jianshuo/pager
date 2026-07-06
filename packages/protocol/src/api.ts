import { z } from "zod";
import { PermissionChoice, StatusState } from "./event.js";

export const MachineSummary = z.object({
  id: z.string(),
  name: z.string(),
  online: z.boolean(),
  dirs: z.array(z.string()),
});
export type MachineSummary = z.infer<typeof MachineSummary>;

export const ConversationSummary = z.object({
  id: z.string(),
  machineId: z.string(),
  machineName: z.string(),
  dir: z.string(),
  state: StatusState,
  lastMessage: z.string(),
  lastSeq: z.number().int().nonnegative(),
  updatedAt: z.number().int(),
});
export type ConversationSummary = z.infer<typeof ConversationSummary>;

export const NewConversationRequest = z.object({
  machineId: z.string(),
  dir: z.string(),
  message: z.string().min(1),
});
export type NewConversationRequest = z.infer<typeof NewConversationRequest>;

export const PermissionResponseRequest = z.object({
  conv: z.string(),
  request_id: z.string(),
  choice: PermissionChoice,
});
export type PermissionResponseRequest = z.infer<typeof PermissionResponseRequest>;

export const DeviceRegistration = z.object({
  deviceToken: z.string(),
});
export type DeviceRegistration = z.infer<typeof DeviceRegistration>;
