// 端到端冒烟：假 daemon + 真 REST 客户端，走完整事件回路
// 用法：HUB_URL=... DAEMON_TOKEN=... CLIENT_TOKEN=... node scripts/smoke.mjs
import WebSocket from "ws";

const HUB = process.env.HUB_URL ?? "http://127.0.0.1:8787";
const DAEMON_TOKEN = process.env.DAEMON_TOKEN ?? "test-daemon-token";
const CLIENT_TOKEN = process.env.CLIENT_TOKEN ?? "test-client-token";
const WS_URL = HUB.replace(/^http/, "ws");
const MACHINE = "mch_smoke";

function fail(msg) {
  console.error(`SMOKE FAIL: ${msg}`);
  process.exit(1);
}

const now = () => Math.floor(Date.now() / 1000);

async function api(path, init = {}) {
  const res = await fetch(`${HUB}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${CLIENT_TOKEN}`, ...(init.headers ?? {}) },
  });
  return res;
}

// 1. 假 daemon 上线
const ws = new WebSocket(`${WS_URL}/ws/daemon?machine=${MACHINE}`, {
  headers: { Authorization: `Bearer ${DAEMON_TOKEN}` },
});
await new Promise((ok, no) => {
  ws.once("open", ok);
  ws.once("error", no);
});
ws.send(
  JSON.stringify({
    kind: "hello",
    proto: 1,
    machine: { id: MACHINE, name: "SmokeDaemon" },
    dirs: ["/tmp/smoke"],
    maxConcurrent: 1,
  })
);

// daemon 收到 task 后回三条事件
let evtN = 0;
const draft = (conv, type, body) => ({
  id: `evt_smoke_${++evtN}_${Date.now()}`,
  conv,
  ts: now(),
  role: "agent",
  agent: "claude-code",
  type,
  body,
});
ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.kind !== "task") return;
  const conv = msg.conv;
  console.log(`daemon: 收到 task conv=${conv} dir=${msg.dir} 首条消息「${msg.event.body.markdown}」`);
  ws.send(JSON.stringify({ kind: "event", event: draft(conv, "status", { state: "running" }) }));
  ws.send(JSON.stringify({ kind: "event", event: draft(conv, "text", { markdown: "冒烟回复：任务完成。" }) }));
  ws.send(JSON.stringify({ kind: "event", event: draft(conv, "status", { state: "done" }) }));
});

// 2. 等机器在线
for (let i = 0; ; i++) {
  const machines = await (await api("/api/machines")).json();
  if (machines.some((m) => m.id === MACHINE && m.online)) break;
  if (i > 40) fail("机器 10s 未上线");
  await new Promise((r) => setTimeout(r, 250));
}
console.log("client: 机器已在线");

// 3. 新建会话
const res = await api("/api/conversations", {
  method: "POST",
  body: JSON.stringify({ machineId: MACHINE, dir: "/tmp/smoke", message: "冒烟测试" }),
});
if (res.status !== 201) fail(`新建会话 ${res.status}`);
const { id: conv } = await res.json();
console.log(`client: 会话 ${conv} 已创建`);

// 4. 等会话完成
for (let i = 0; ; i++) {
  const list = await (await api("/api/conversations")).json();
  const row = list.find((c) => c.id === conv);
  if (row?.state === "done") {
    console.log(`client: 会话状态 done，lastSeq=${row.lastSeq}`);
    break;
  }
  if (i > 40) fail(`会话 10s 未到 done（当前 ${row?.state}）`);
  await new Promise((r) => setTimeout(r, 250));
}

ws.close();
console.log("SMOKE PASS");
process.exit(0);
