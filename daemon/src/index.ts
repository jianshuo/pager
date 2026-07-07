import { join } from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "./config.js";
import { SessionStore } from "./state.js";
import { HubClient } from "./hub.js";
import { Runner } from "./runner.js";
import { createClaudeCodeAdapter } from "./adapters/claude-code.js";

const cfg = loadConfig();
const store = new SessionStore(
  process.env.PAGER_DAEMON_STATE ?? join(homedir(), ".pager", "state.json")
);
store.load();

const client: HubClient = new HubClient(
  { hubUrl: cfg.hubUrl, daemonToken: cfg.daemonToken, machineId: cfg.machineId },
  {
    onOpen() {
      console.log(`connected to ${cfg.hubUrl} as ${cfg.machineId}`);
      client.send({
        kind: "hello",
        proto: 1,
        machine: { id: cfg.machineId, name: cfg.machineName },
        dirs: cfg.dirs,
        maxConcurrent: cfg.maxConcurrent,
      });
    },
    onMessage(msg) {
      runner.handle(msg);
    },
  }
);

const runner = new Runner(
  {
    maxConcurrent: cfg.maxConcurrent,
    permissionTimeoutSec: cfg.permissionTimeoutSec,
    permissionMode: cfg.permissionMode,
    dirs: cfg.dirs,
  },
  createClaudeCodeAdapter(),
  store,
  (m) => {
    if (!client.send(m)) console.error("hub offline, dropped:", m.kind);
  }
);

client.connect();
console.log("pager daemon started");

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`${sig} received, shutting down`);
    client.close();
    process.exit(0);
  });
}
