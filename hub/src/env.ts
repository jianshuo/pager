export interface Env {
  CONVERSATION: DurableObjectNamespace;
  USER: DurableObjectNamespace;
  DIRECTORY: DurableObjectNamespace;
  MACHINE: DurableObjectNamespace; // 过渡：Phase 4 路由重写后移除
  DAEMON_TOKEN: string;
  CLIENT_TOKEN: string;
  // AI 成员后端：LLM API key（未配则 bot 回错误提示）；BOT_MOCK 存在时测试走固定回复。
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  BOT_MOCK?: string;
  // APNs——未配置时推送静默跳过（Task 6）
  APNS_TEAM_ID?: string;
  APNS_KEY_ID?: string;
  APNS_P8?: string;
  APNS_BUNDLE_ID?: string;
  APNS_ENV?: string; // "sandbox" | "production"
}
