// 生产端到端验收：REST 建会话 → daemon 驱动本机 Claude Code 创建文件 →
// 客户端 WS 全程围观并自动批准权限 → 轮询 done → 校验文件存在
// 用法：source hub/.secrets.production.local && node daemon/scripts/e2e.mjs
import WebSocket from "ws";
import { existsSync, readFileSync, rmSync, realpathSync } from "node:fs";

const HUB = process.env.HUB_URL ?? "https://pager-hub.jianshuo.workers.dev";
const CLIENT_TOKEN = process.env.CLIENT_TOKEN;
const MACHINE_ID = process.env.MACHINE_ID ?? "mch_mac";
const MARKER = `pager-e2e-${Date.now()}`;
const WORKDIR = "/tmp/pager-e2e";
// macOS /tmp → /private/tmp：按真实路径校验，容忍 Claude 用绝对路径
const REALDIR = existsSync(WORKDIR) ? realpathSync(WORKDIR) : WORKDIR;
const FILE = `${REALDIR}/${MARKER}.txt`;

if (!CLIENT_TOKEN) {
  console.error("需要 CLIENT_TOKEN（source hub/.secrets.production.local）");
  process.exit(1);
}
const fail = (m) => {
  console.error(`E2E FAIL: ${m}`);
  process.exit(1);
};
const api = (path, init = {}) =>
  fetch(`${HUB}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${CLIENT_TOKEN}`, ...(init.headers ?? {}) },
  });

// 1. 机器在线？
const machines = await (await api("/api/machines")).json();
if (!machines.find((m) => m.id === MACHINE_ID && m.online))
  fail(`机器 ${MACHINE_ID} 不在线（daemon 装好了吗）`);
console.log("daemon 在线 ✓");

// 2. 客户端 WS：围观 + 自动批准权限
let conv = null;
const ws = new WebSocket(`${HUB.replace(/^http/, "ws")}/ws/client`, {
  headers: { Authorization: `Bearer ${CLIENT_TOKEN}` },
});
await new Promise((ok, no) => {
  ws.once("open", ok);
  ws.once("error", no);
});
ws.on("message", async (data) => {
  const m = JSON.parse(data.toString());
  if (m.kind === "event" && m.event.type === "permission_request" && m.event.conv === conv) {
    console.log(`收到权限请求：${m.event.body.description} → 自动批准`);
    await api("/api/permission-response", {
      method: "POST",
      body: JSON.stringify({ conv, request_id: m.event.body.request_id, choice: "allow" }),
    });
  }
  if (m.kind === "event" && m.event.conv === conv)
    console.log(`  [${m.event.type}]`, JSON.stringify(m.event.body).slice(0, 120));
});

// 3. 建会话
const res = await api("/api/conversations", {
  method: "POST",
  body: JSON.stringify({
    machineId: MACHINE_ID,
    dir: WORKDIR,
    message: `先运行 pwd 确认你的当前工作目录，然后在那个目录（就是 pwd 打印的路径）下创建文件 ${MARKER}.txt，内容写 "hello from pager"。用相对文件名，不要写到别的目录。创建完就结束，不要做别的。`,
  }),
});
if (res.status !== 201) fail(`建会话 ${res.status}: ${await res.text()}`);
conv = (await res.json()).id;
console.log(`会话 ${conv} 已创建，等 Claude Code 干活…`);

// 4. 轮询 done（最多 5 分钟）
for (let i = 0; ; i++) {
  const list = await (await api("/api/conversations")).json();
  const row = list.find((c) => c.id === conv);
  if (row?.state === "done") break;
  if (row?.state === "failed") fail(`会话 failed: ${row.lastMessage}`);
  if (i > 150) fail(`5 分钟未完成（当前 ${row?.state}）`);
  await new Promise((r) => setTimeout(r, 2000));
}

// 5. 校验产物
if (!existsSync(FILE)) fail(`文件不存在: ${FILE}`);
console.log(`文件内容: ${readFileSync(FILE, "utf8").trim()}`);
rmSync(FILE, { force: true });
ws.close();
console.log("E2E PASS");
process.exit(0);
