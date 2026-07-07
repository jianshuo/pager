import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
    try {
      this.map = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      this.map = {};
    }
  }

  get(conv: string): ConvState | undefined {
    return this.map[conv];
  }

  set(conv: string, patch: ConvState): void {
    this.map[conv] = { ...this.map[conv], ...patch };
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.map, null, 2));
  }
}
