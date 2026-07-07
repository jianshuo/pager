import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonConfig, loadConfig } from "../src/config.js";

const VALID = {
  hubUrl: "https://pager-hub.jianshuo.workers.dev",
  daemonToken: "tok",
  machineId: "mch_mac",
  machineName: "建硕的 Mac",
  dirs: ["/tmp/pager-e2e"],
};

describe("DaemonConfig", () => {
  it("合法配置解析并给默认值", () => {
    const c = DaemonConfig.parse(VALID);
    expect(c.maxConcurrent).toBe(4);
    expect(c.permissionTimeoutSec).toBe(3600);
    expect(c.permissionMode).toBe("default");
  });

  it("machineId 前缀错误拒绝", () => {
    expect(() => DaemonConfig.parse({ ...VALID, machineId: "mac" })).toThrow();
  });

  it("dirs 空数组拒绝", () => {
    expect(() => DaemonConfig.parse({ ...VALID, dirs: [] })).toThrow();
  });

  it("loadConfig 从文件读", () => {
    const dir = mkdtempSync(join(tmpdir(), "pager-cfg-"));
    const p = join(dir, "daemon.json");
    writeFileSync(p, JSON.stringify({ ...VALID, maxConcurrent: 2 }));
    expect(loadConfig(p).maxConcurrent).toBe(2);
  });
});
