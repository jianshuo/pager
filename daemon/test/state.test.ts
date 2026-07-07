import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/state.js";

describe("SessionStore", () => {
  it("set/get 并跨实例持久化（merge 语义）", () => {
    const file = join(mkdtempSync(join(tmpdir(), "pager-state-")), "sub", "state.json");
    const a = new SessionStore(file);
    a.load();
    expect(a.get("cnv_1")).toBeUndefined();
    a.set("cnv_1", { dir: "/proj" });
    a.set("cnv_1", { agentSessionId: "s-1" });

    const b = new SessionStore(file);
    b.load();
    expect(b.get("cnv_1")).toEqual({ dir: "/proj", agentSessionId: "s-1" });
  });

  it("文件缺失/损坏时 load 得到空表", () => {
    const file = join(mkdtempSync(join(tmpdir(), "pager-state-")), "state.json");
    const s = new SessionStore(file);
    s.load();
    expect(s.get("cnv_x")).toBeUndefined();
  });
});
