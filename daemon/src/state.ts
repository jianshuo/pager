import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface ConvState {
  agentSessionId?: string;
  dir?: string;
}

// conv → 会话状态。hub 不回传 agentSessionId 映射，daemon 自己持久化（重启后可 resume）
export class SessionStore {
  private map: Record<string, ConvState> = {};

  constructor(private file: string) {}

  load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        this.map = {}; // 首次运行，文件不存在，静默即可
        return;
      }
      this.handleCorrupt(err);
      return;
    }
    try {
      this.map = JSON.parse(raw);
    } catch (err) {
      this.handleCorrupt(err);
    }
  }

  private handleCorrupt(err: unknown): void {
    console.error(`SessionStore: 无法读取/解析 ${this.file}，已保留原文件为 .corrupt 备份`, err);
    try {
      renameSync(this.file, `${this.file}.corrupt`);
    } catch {
      // 备份失败（例如文件已不存在）也不影响继续以空表运行
    }
    this.map = {};
  }

  get(conv: string): ConvState | undefined {
    return this.map[conv];
  }

  set(conv: string, patch: ConvState): void {
    this.map[conv] = { ...this.map[conv], ...patch };
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.map, null, 2));
    renameSync(tmp, this.file); // 原子替换：崩溃/断电不会留下半写的坏文件
  }
}
