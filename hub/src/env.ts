export interface Env {
  CONVERSATION: DurableObjectNamespace;
  MACHINE: DurableObjectNamespace;
  USER: DurableObjectNamespace;
  DAEMON_TOKEN: string;
  CLIENT_TOKEN: string;
  // APNs——未配置时推送静默跳过（Task 6）
  APNS_TEAM_ID?: string;
  APNS_KEY_ID?: string;
  APNS_P8?: string;
  APNS_BUNDLE_ID?: string;
  APNS_ENV?: string; // "sandbox" | "production"
}
