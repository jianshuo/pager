import type { DaemonToHub, PermissionChoice } from "@pager/protocol";

export interface PermissionRequest {
  request_id: string;
  tool: string;
  description: string;
  options: PermissionChoice[];
}

export interface RunOptions {
  conv: string;
  dir: string;
  prompt: string;
  agentSessionId?: string;
  permissionMode: string;
  emit(msg: DaemonToHub): void;
  requestPermission(req: PermissionRequest): Promise<PermissionChoice>;
}

export interface RunHandle {
  interrupt(): void;
  done: Promise<void>;
}

export interface AgentAdapter {
  run(opts: RunOptions): RunHandle;
}
