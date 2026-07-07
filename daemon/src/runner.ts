import { newId, type DaemonToHub, type HubToDaemon, type PermissionChoice } from "@pager/protocol";
import type { AgentAdapter, PermissionRequest } from "./adapters/types.js";
import type { SessionStore } from "./state.js";

const nowSec = () => Math.floor(Date.now() / 1000);

interface RunnerConfig {
  maxConcurrent: number;
  permissionTimeoutSec: number;
  permissionMode: string;
  dirs: string[];
}

interface ConvRuntime {
  running: boolean;
  interrupt?: () => void;
  followups: string[]; // 排队的追加消息
}

interface QueuedStart {
  conv: string;
  prompt: string;
}

interface PendingPermission {
  conv: string;
  resolve: (choice: PermissionChoice) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class Runner {
  private convs = new Map<string, ConvRuntime>();
  private active = 0;
  private startQueue: QueuedStart[] = [];
  private pendingPermissions = new Map<string, PendingPermission>();

  constructor(
    private cfg: RunnerConfig,
    private adapter: AgentAdapter,
    private store: SessionStore,
    private send: (msg: DaemonToHub) => void
  ) {}

  handle(msg: HubToDaemon): void {
    switch (msg.kind) {
      case "task": {
        if (!this.cfg.dirs.includes(msg.dir)) {
          this.emitStatus(msg.conv, "failed", `目录不在白名单：${msg.dir}`);
          return;
        }
        this.store.set(msg.conv, { dir: msg.dir });
        const prompt = msg.event.type === "text" ? (msg.event.body as { markdown: string }).markdown : "";
        this.requestStart(msg.conv, prompt);
        break;
      }
      case "user_event": {
        const ev = msg.event as { type: string; body: unknown };
        if (ev.type === "permission_response") {
          const body = ev.body as { request_id: string; choice: PermissionChoice };
          const entry = this.pendingPermissions.get(body.request_id);
          if (entry) {
            this.pendingPermissions.delete(body.request_id);
            clearTimeout(entry.timer);
            entry.resolve(body.choice);
          }
          return;
        }
        if (ev.type === "text") {
          const state = this.store.get(msg.conv);
          if (!state?.dir) return; // 未知 conv：容忍丢弃
          const md = (ev.body as { markdown: string }).markdown;
          this.requestStart(msg.conv, md);
        }
        break;
      }
      case "interrupt": {
        this.convs.get(msg.conv)?.interrupt?.();
        // 打断该 conv 时一并清掉它挂起的权限等待，避免过期计时器之后再冒出一条状态
        for (const [reqId, entry] of [...this.pendingPermissions]) {
          if (entry.conv === msg.conv) {
            clearTimeout(entry.timer);
            this.pendingPermissions.delete(reqId);
            entry.resolve("deny");
          }
        }
        break;
      }
    }
  }

  // 唯一的起跑准入口：conv 是否已在跑 / 是否已排队 / 并发是否有空位，都在这里一次判定
  private requestStart(conv: string, prompt: string): void {
    let rt = this.convs.get(conv);
    if (!rt) {
      rt = { running: false, followups: [] };
      this.convs.set(conv, rt);
    }

    if (rt.running || this.startQueue.some((q) => q.conv === conv)) {
      rt.followups.push(prompt);
      return;
    }

    if (this.active >= this.cfg.maxConcurrent) {
      this.startQueue.push({ conv, prompt });
      this.emitStatus(conv, "thinking", `排队中（${this.startQueue.length - 1} 个任务在前面）`);
      return;
    }

    this.start(conv, prompt);
  }

  private start(conv: string, prompt: string): void {
    const state = this.store.get(conv);
    if (!state?.dir) return;
    this.active++;
    let rt = this.convs.get(conv);
    if (!rt) {
      rt = { running: false, followups: [] };
      this.convs.set(conv, rt);
    }
    rt.running = true;

    const handle = this.adapter.run({
      conv,
      dir: state.dir,
      prompt,
      agentSessionId: state.agentSessionId,
      permissionMode: this.cfg.permissionMode,
      emit: (m) => {
        if (m.kind === "session") this.store.set(conv, { agentSessionId: m.agentSessionId });
        this.send(m);
      },
      requestPermission: (req) => this.awaitPermission(conv, req),
    });
    rt.interrupt = handle.interrupt;

    void handle.done.finally(() => {
      rt.running = false;
      this.active--;
      const next = rt.followups.shift();
      if (next !== undefined) {
        this.start(conv, next); // 同 conv 续跑（带 resume）
        return;
      }
      const queued = this.startQueue.shift();
      if (queued) this.start(queued.conv, queued.prompt);
    });
  }

  private awaitPermission(conv: string, req: PermissionRequest): Promise<PermissionChoice> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPermissions.delete(req.request_id);
        this.emitStatus(conv, "running", `权限请求超时（${this.cfg.permissionTimeoutSec}s），已自动拒绝：${req.description}`);
        resolve("deny");
      }, this.cfg.permissionTimeoutSec * 1000);
      this.pendingPermissions.set(req.request_id, { conv, resolve, timer });
    });
  }

  private emitStatus(conv: string, state: string, note?: string): void {
    this.send({
      kind: "event",
      event: {
        id: newId("evt"), conv, ts: nowSec(), role: "system", agent: "claude-code",
        type: "status", body: note ? { state, note } : { state },
      } as never,
    });
  }
}
