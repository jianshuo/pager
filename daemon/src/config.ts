import { z } from "zod";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DaemonConfig = z.object({
  hubUrl: z.string().url(),
  daemonToken: z.string().min(1),
  machineId: z.string().startsWith("mch_"),
  machineName: z.string().min(1),
  dirs: z.array(z.string().min(1)).min(1),
  maxConcurrent: z.number().int().positive().default(4),
  permissionTimeoutSec: z.number().int().positive().default(3600),
  permissionMode: z.string().default("default"),
});
export type DaemonConfig = z.infer<typeof DaemonConfig>;

export function defaultConfigPath(): string {
  return process.env.PAGER_DAEMON_CONFIG ?? join(homedir(), ".pager", "daemon.json");
}

export function loadConfig(path = defaultConfigPath()): DaemonConfig {
  return DaemonConfig.parse(JSON.parse(readFileSync(path, "utf8")));
}
