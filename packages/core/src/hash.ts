const FNV_OFFSET_BASIS_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;

/** FNV-1a over UTF-8 bytes, returned as an unsigned 32-bit integer. */
export function fnv1a32(value: string): number {
  let hash = FNV_OFFSET_BASIS_32;
  const bytes = new TextEncoder().encode(value);

  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, FNV_PRIME_32) >>> 0;
  }

  return hash >>> 0;
}

export function normalizeBucketValue(value: string | number): string {
  return typeof value === "number" ? `n:${value}` : `s:${value}`;
}

/** Return a stable integer in [0, 9,999]. */
export function bucketFor(bucketValue: string | number, flagKey: string, salt: string): number {
  const encoder = new TextEncoder();
  const part = (value: string) => `${encoder.encode(value).byteLength}:${value}`;
  const input = [normalizeBucketValue(bucketValue), flagKey, salt].map(part).join("");
  return fnv1a32(input) % 10_000;
}
