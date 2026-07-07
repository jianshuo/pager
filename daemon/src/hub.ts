import WebSocket from "ws";
import { HubToDaemon, type DaemonToHub } from "@pager/protocol";

export interface HubClientOptions {
  hubUrl: string;
  daemonToken: string;
  machineId: string;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

export interface HubHandlers {
  onOpen(): void;
  onMessage(msg: HubToDaemon): void;
}

export class HubClient {
  private ws: WebSocket | null = null;
  private closed = false;
  private backoff: number;
  private readonly base: number;
  private readonly max: number;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private opts: HubClientOptions, private handlers: HubHandlers) {
    this.base = opts.baseBackoffMs ?? 1000;
    this.max = opts.maxBackoffMs ?? 60_000;
    this.backoff = this.base;
  }

  connect(): void {
    if (this.closed) return;
    const url = `${this.opts.hubUrl.replace(/^http/, "ws")}/ws/daemon?machine=${this.opts.machineId}`;
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${this.opts.daemonToken}` } });
    this.ws = ws;

    ws.on("open", () => {
      this.backoff = this.base;
      this.handlers.onOpen();
    });
    ws.on("message", (data) => {
      let msg: HubToDaemon;
      try {
        msg = HubToDaemon.parse(JSON.parse(data.toString()));
      } catch (err) {
        console.error("hub message dropped:", err);
        return;
      }
      this.handlers.onMessage(msg);
    });
    ws.on("close", () => this.scheduleReconnect());
    ws.on("error", () => {
      /* close 事件随后触发，重连在那里排 */
    });
  }

  send(msg: DaemonToHub): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false; // at-most-once：不在线即丢
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    this.timer = setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, this.max);
  }
}
