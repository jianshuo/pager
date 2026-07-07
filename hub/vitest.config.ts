import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
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
