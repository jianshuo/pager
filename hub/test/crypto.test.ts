import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "../src/crypto.js";

describe("PBKDF2 密码 hash", () => {
  it("hash 后 verify 往返成功", async () => {
    const h = await hashPassword("hunter2");
    expect(h.startsWith("pbkdf2$100000$")).toBe(true);
    expect(await verifyPassword("hunter2", h)).toBe(true);
  });

  it("错误密码 verify 失败", async () => {
    const h = await hashPassword("hunter2");
    expect(await verifyPassword("wrong", h)).toBe(false);
  });

  it("同一密码两次 hash 因随机 salt 而不同", async () => {
    expect(await hashPassword("same")).not.toBe(await hashPassword("same"));
  });

  it("非法存储字符串一律 false", async () => {
    expect(await verifyPassword("x", "garbage")).toBe(false);
    expect(await verifyPassword("x", "pbkdf2$abc$def")).toBe(false);
  });
});
