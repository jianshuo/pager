// 轮询直到 fn 返回真值（DO 的 WS 消息处理是异步的，测试里用它等状态收敛）
export async function until<T>(
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 3000
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error("until(): timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
}
