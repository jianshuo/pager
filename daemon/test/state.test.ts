import { describe, it, expect, vi, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/state.js";

describe("SessionStore", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it("文件缺失时 load 静默得到空表", () => {
    const file = join(mkdtempSync(join(tmpdir(), "pager-state-")), "state.json");
    const s = new SessionStore(file);
    s.load();
    expect(s.get("cnv_x")).toBeUndefined();
  });

  it("文件损坏（非法 JSON）时 load 记错误日志、留空表、把坏文件备份为 .corrupt", () => {
    const file = join(mkdtempSync(join(tmpdir(), "pager-state-")), "state.json");
    const badContent = "{ this is not valid json,,,";
    writeFileSync(file, badContent);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const s = new SessionStore(file);
    s.load();

    expect(s.get("cnv_x")).toBeUndefined(); // 空表，没有崩
    expect(errSpy).toHaveBeenCalled(); // 大声记日志
    expect(existsSync(`${file}.corrupt`)).toBe(true); // 坏文件被备份，不是静默吞掉
    expect(readFileSync(`${file}.corrupt`, "utf8")).toBe(badContent); // 备份内容就是原始坏内容

    // 后续 set() 不应把 .corrupt 备份也覆盖掉（备份是快照，不再联动）
    s.set("cnv_1", { dir: "/proj" });
    expect(readFileSync(`${file}.corrupt`, "utf8")).toBe(badContent);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ cnv_1: { dir: "/proj" } });
  });

  it("写入是原子的：set() 不留下 .tmp 残留文件", () => {
    const file = join(mkdtempSync(join(tmpdir(), "pager-state-")), "state.json");
    const s = new SessionStore(file);
    s.load();
    s.set("cnv_1", { dir: "/proj" });
    expect(existsSync(`${file}.tmp`)).toBe(false);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ cnv_1: { dir: "/proj" } });
  });
});
