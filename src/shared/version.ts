/** Stable versions shared by publication and update consumers. */
export function stableVersion(value: unknown): bigint[] | undefined {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value)) return;
  return value.split("+")[0]!.split(".").map(BigInt);
}
