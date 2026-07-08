import { z } from "zod";

// ---------- 账号 ----------

// 用户名即 user id 的可搜索句柄：小写字母/数字/下划线，3–20，唯一。归一化到小写。
export const Username = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.string().regex(/^[a-z0-9_]{3,20}$/, "用户名需 3–20 位小写字母/数字/下划线"));

export const Password = z.string().min(6, "密码至少 6 位").max(200);

export const RegisterRequest = z.object({ username: Username, password: Password });
export type RegisterRequest = z.infer<typeof RegisterRequest>;

export const LoginRequest = z.object({ username: Username, password: Password });
export type LoginRequest = z.infer<typeof LoginRequest>;

export const AuthResponse = z.object({
  userId: z.string().startsWith("usr_"),
  username: z.string(),
  token: z.string().startsWith("stk_"),
});
export type AuthResponse = z.infer<typeof AuthResponse>;

export const UserSummary = z.object({
  userId: z.string().startsWith("usr_"),
  username: z.string(),
});
export type UserSummary = z.infer<typeof UserSummary>;

// ---------- 好友 ----------

export const AddFriendRequest = z.object({ userId: z.string().startsWith("usr_") });
export type AddFriendRequest = z.infer<typeof AddFriendRequest>;

// ---------- 会话 / 群 ----------

export const ConvKind = z.enum(["direct", "group"]);
export type ConvKind = z.infer<typeof ConvKind>;

export const DirectConversationRequest = z.object({ userId: z.string().startsWith("usr_") });
export type DirectConversationRequest = z.infer<typeof DirectConversationRequest>;

export const NewGroupRequest = z.object({
  title: z.string().trim().min(1).max(60),
  members: z.array(z.string().startsWith("usr_")).default([]),
});
export type NewGroupRequest = z.infer<typeof NewGroupRequest>;

export const AddMemberRequest = z.object({ userId: z.string().startsWith("usr_") });
export type AddMemberRequest = z.infer<typeof AddMemberRequest>;

// 会话列表条目：1:1 显示对方 username（title 空），群显示 title（peer 空）
export const ConversationSummary = z.object({
  id: z.string(),
  kind: ConvKind,
  title: z.string().default(""),
  peerUserId: z.string().default(""),
  peerUsername: z.string().default(""),
  lastMessage: z.string().default(""),
  lastSeq: z.number().int().nonnegative().default(0),
  updatedAt: z.number().int().default(0), // epoch 秒
});
export type ConversationSummary = z.infer<typeof ConversationSummary>;

export const ConversationRef = z.object({ id: z.string().min(1) });
export type ConversationRef = z.infer<typeof ConversationRef>;

// ---------- 设备（APNs） ----------

export const DeviceRegistration = z.object({ deviceToken: z.string() });
export type DeviceRegistration = z.infer<typeof DeviceRegistration>;
