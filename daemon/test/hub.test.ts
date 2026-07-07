import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import type { AddressInfo } from "node:net";
import { HubClient } from "../src/hub.js";

function until<T>(fn: () => T | undefined | null | false, ms = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const t = setInterval(() => {
      const v = fn();
      if (v) { clearInterval(t); resolve(v); }
      else if (Date.now() - start > ms) { clearInterval(t); reject(new Error("until timeout")); }
    }, 20);
  });
}

let servers: WebSocketServer[] = [];
let clients: HubClient[] = [];
afterEach(() => {
  clients.forEach((c) => c.close());
  servers.forEach((s) => s.close());
  clients = []; servers = [];
});

function fakeHub() {
  const wss = new WebSocketServer({ port: 0 });
  servers.push(wss);
  const state: { sockets: ServerSocket[]; received: any[]; headers: any[]; urls: string[] } = { sockets: [], received: [], headers: [], urls: [] };
  wss.on("connection", (socket, req) => {
    state.sockets.push(socket);
    state.headers.push(req.headers);
    state.urls.push(req.url ?? "");
    socket.on("message", (d) => state.received.push(JSON.parse(d.toString())));
  });
  const port = (wss.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, state };
}

function makeClient(url: string, onMessage: (m: any) => void = () => {}) {
  const got = { opened: 0 };
  const c = new HubClient(
    { hubUrl: url, daemonToken: "tok", machineId: "mch_t", baseBackoffMs: 50, maxBackoffMs: 200 },
    { onOpen: () => { got.opened++; }, onMessage }
  );
  clients.push(c);
  return { c, got };
}

describe("HubClient", () => {
  it("连接带 Bearer 头与 machine 参数，open 回调触发，send 上行", async () => {
    const hub = fakeHub();
    const { c, got } = makeClient(hub.url);
    c.connect();
    await until(() => got.opened === 1);
    expect(hub.state.headers[0].authorization).toBe("Bearer tok");
    expect(hub.state.urls[0]).toContain("machine=mch_t");
    c.send({ kind: "patch", conv: "cnv_1", eventId: "evt_1", markdown: "hi" });
    await until(() => hub.state.received.length === 1);
    expect(hub.state.received[0].kind).toBe("patch");
  });

  it("收到合法 HubToDaemon 回调，非法消息丢弃不炸", async () => {
    const hub = fakeHub();
    const msgs: any[] = [];
    const { c, got } = makeClient(hub.url, (m) => msgs.push(m));
    c.connect();
    await until(() => got.opened === 1);
    hub.state.sockets[0].send("not json");
    hub.state.sockets[0].send(JSON.stringify({ kind: "nope" }));
    hub.state.sockets[0].send(JSON.stringify({ kind: "interrupt", conv: "cnv_1" }));
    await until(() => msgs.length === 1);
    expect(msgs[0]).toEqual({ kind: "interrupt", conv: "cnv_1" });
  });

  it("服务端断开后自动重连", async () => {
    const hub = fakeHub();
    const { c, got } = makeClient(hub.url);
    c.connect();
    await until(() => got.opened === 1);
    hub.state.sockets[0].close();
    await until(() => got.opened === 2);
    expect(got.opened).toBe(2);
  });

  it("close() 后不再重连，未连接时 send 返回 false", async () => {
    const hub = fakeHub();
    const { c, got } = makeClient(hub.url);
    c.connect();
    await until(() => got.opened === 1);
    c.close();
    expect(c.send({ kind: "patch", conv: "c", eventId: "e", markdown: "x" })).toBe(false);
    await new Promise((r) => setTimeout(r, 300));
    expect(got.opened).toBe(1);
  });
});
