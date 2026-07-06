// Workers 与 Node ≥ 20 都有全局 crypto；不引 DOM lib，自己声明最小面
declare const crypto: { randomUUID(): string };

export type IdPrefix = "evt" | "cnv" | "mch";

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${crypto.randomUUID()}`;
}
