export type IdPrefix = "evt" | "cnv" | "mch";

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${crypto.randomUUID()}`;
}
