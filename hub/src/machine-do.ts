import { DurableObject } from "cloudflare:workers";
import { DaemonHello, DaemonPatch, DaemonSession, EventDraftLoose, type HubToDaemon } from "@pager/protocol";
import type { Env } from "./env.js";

interface MachineInfoStored {
  machine: { id: string; name: string };
  dirs: string[];
  maxConcurrent: number;
  proto: number;
}

export class MachineDO extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      if (req.headers.get("Upgrade") !== "websocket")
        return new Response("expected websocket", { status: 426 });
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (url.pathname === "/deliver" && req.method === "POST") {
      const msg = (await req.json()) as HubToDaemon;
      const sockets = this.ctx.getWebSockets();
      if (sockets.length === 0) return Response.json({ delivered: false });
      for (const ws of sockets) ws.send(JSON.stringify(msg));
      return Response.json({ delivered: true });
    }

    if (url.pathname === "/info") {
      const info = await this.ctx.storage.get<MachineInfoStored>("info");
      if (!info) return Response.json(null);
      return Response.json({ ...info, online: this.ctx.getWebSockets().length > 0 });
    }

    return new Response("not found", { status: 404 });
  }

  async webSocketMessage(_ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (typeof data !== "string") return;
    let msg: { kind?: string; event?: unknown };
    try {
      msg = JSON.parse(data);
    } catch {
      return; // 非 JSON：忽略，不炸 socket
    }
    try {
      switch (msg.kind) {
        case "hello": {
          const hello = DaemonHello.parse(msg);
          const info: MachineInfoStored = {
            machine: hello.machine,
            dirs: hello.dirs,
            maxConcurrent: hello.maxConcurrent,
            proto: hello.proto,
          };
          await this.ctx.storage.put("info", info);
          await this.notifyStatus(info, true);
          break;
        }
        case "event": {
          const event = EventDraftLoose.parse(msg.event);
          await this.conv(event.conv).fetch("https://do/ingest", {
            method: "POST",
            body: JSON.stringify({ event }),
          });
          break;
        }
        case "patch": {
          const patch = DaemonPatch.parse(msg);
          await this.conv(patch.conv).fetch("https://do/patch", {
            method: "POST",
            body: JSON.stringify(patch),
          });
          break;
        }
        case "session": {
          const s = DaemonSession.parse(msg);
          await this.conv(s.conv).fetch("https://do/session", {
            method: "POST",
            body: JSON.stringify(s),
          });
          break;
        }
      }
    } catch {
      // 校验失败：丢弃该消息，不影响连接（宽松姿态只对 event.type/body；envelope 坏了就丢）
    }
  }

  async webSocketClose(): Promise<void> {
    if (this.ctx.getWebSockets().length === 0) {
      const info = await this.ctx.storage.get<MachineInfoStored>("info");
      if (info) await this.notifyStatus(info, false);
    }
  }

  private conv(conv: string): DurableObjectStub {
    return this.env.CONVERSATION.get(this.env.CONVERSATION.idFromName(conv));
  }

  private async notifyStatus(info: MachineInfoStored, online: boolean): Promise<void> {
    await this.env.USER.get(this.env.USER.idFromName("user")).fetch("https://do/machine-status", {
      method: "POST",
      body: JSON.stringify({
        machine: info.machine,
        online,
        dirs: info.dirs,
        maxConcurrent: info.maxConcurrent,
      }),
    });
  }
}
