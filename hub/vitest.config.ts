import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        // SQLite DO 的 WAL 文件与隔离存储不兼容（pool-workers 版本代差）；测试全部用唯一 DO 名，共享存储安全
        isolatedStorage: false,
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            DAEMON_TOKEN: "test-daemon-token",
            CLIENT_TOKEN: "test-client-token",
          },
        },
      },
    },
  },
});
