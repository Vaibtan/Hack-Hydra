import { createHash } from "node:crypto"

/**
 * HydraDB node ids are non-negative integers that travel over the HTTP API as
 * JSON numbers, so the usable id space is 53 bits, not 64. We therefore derive
 * an id as the top 53 bits of SHA-256(key).
 *
 * Deviation from the spec's "u64 = xxhash64(key)": same property (a stable,
 * content-addressed id per key string), narrower width, forced by the JSON
 * transport. At ~10^6 vertices the birthday collision probability is ~5e-5.
 */
export const vertexId = (key: string): number => {
  const digest = createHash("sha256").update(key, "utf8").digest()
  return Number(digest.readBigUInt64BE(0) >> 11n)
}

/** Edge ids are content-addressed the same way, from `src|TYPE|dst`. */
export const edgeId = (srcKey: string, relType: string, dstKey: string): number =>
  vertexId(`${srcKey}|${relType}|${dstKey}`)
