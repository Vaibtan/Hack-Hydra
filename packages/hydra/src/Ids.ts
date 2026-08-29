import { createHash } from "node:crypto"
import { Either } from "effect"
import { HydraIdentityIntegrityError } from "./Errors.js"

/** Injectable numeric-id function used only to prove collision handling. */
export type NumericIdForKey = (key: string) => number

/** Full graph identity carried alongside each lossy HydraDB numeric id. */
export interface GraphIdentity {
  readonly key: string
  readonly numericId: number
}

/** In-process guard used before an adapter reads or writes a numeric graph id. */
export interface GraphIdentityRegistry {
  readonly claimRelationship: (key: string) => Either.Either<GraphIdentity, HydraIdentityIntegrityError>
  readonly claimVertex: (key: string) => Either.Either<GraphIdentity, HydraIdentityIntegrityError>
}

/** Full-key evidence observed from a persisted numeric graph record. */
export interface VerifyStoredGraphIdentity {
  readonly kind: "relationship" | "vertex"
  readonly numericId: number
  readonly requestedKey: string
  readonly storedKey: string | null
  readonly numericIdForKey?: NumericIdForKey
}

const keyFingerprint = (key: string): string =>
  createHash("sha256").update(key, "utf8").digest("hex")

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

const claim = (
  kind: "relationship" | "vertex",
  identities: Map<number, string>,
  key: string,
  numericIdForKey: NumericIdForKey
): Either.Either<GraphIdentity, HydraIdentityIntegrityError> => {
  const numericId = numericIdForKey(key)
  if (!Number.isSafeInteger(numericId) || numericId < 0) {
    return Either.left(
      new HydraIdentityIntegrityError({
        kind,
        reason: "numericMismatch",
        numericId,
        existingKeyFingerprint: null,
        requestedKeyFingerprint: keyFingerprint(key)
      })
    )
  }
  const existing = identities.get(numericId)
  if (existing !== undefined && existing !== key) {
    return Either.left(
      new HydraIdentityIntegrityError({
        kind,
        reason: "numericCollision",
        numericId,
        existingKeyFingerprint: keyFingerprint(existing),
        requestedKeyFingerprint: keyFingerprint(key)
      })
    )
  }
  identities.set(numericId, key)
  return Either.right({ key, numericId })
}

/**
 * Creates a process-local collision guard. Durable full-key verification is
 * performed by the Hydra adapter before a remote merge or direct read.
 */
export const createGraphIdentityRegistry = (
  numericIdForKey: NumericIdForKey = vertexId
): GraphIdentityRegistry => {
  const relationships = new Map<number, string>()
  const vertices = new Map<number, string>()
  return {
    claimRelationship: (key) => claim("relationship", relationships, key, numericIdForKey),
    claimVertex: (key) => claim("vertex", vertices, key, numericIdForKey)
  }
}

/**
 * Verifies a remote identity property before the client reads or overwrites a
 * lossy numeric record. A missing property is unsafe after the integrity
 * contract is enabled: it could conceal a pre-existing collision.
 */
export const verifyStoredGraphIdentity = (
  input: VerifyStoredGraphIdentity
): Either.Either<void, HydraIdentityIntegrityError> => {
  const requestedKeyFingerprint = keyFingerprint(input.requestedKey)
  if (input.storedKey === null) {
    return Either.left(
      new HydraIdentityIntegrityError({
        kind: input.kind,
        reason: "missingFullKey",
        numericId: input.numericId,
        existingKeyFingerprint: null,
        requestedKeyFingerprint
      })
    )
  }
  if (input.storedKey !== input.requestedKey) {
    return Either.left(
      new HydraIdentityIntegrityError({
        kind: input.kind,
        reason: "numericCollision",
        numericId: input.numericId,
        existingKeyFingerprint: keyFingerprint(input.storedKey),
        requestedKeyFingerprint
      })
    )
  }
  const numericIdForKey = input.numericIdForKey ?? vertexId
  if (numericIdForKey(input.storedKey) !== input.numericId) {
    return Either.left(
      new HydraIdentityIntegrityError({
        kind: input.kind,
        reason: "numericMismatch",
        numericId: input.numericId,
        existingKeyFingerprint: keyFingerprint(input.storedKey),
        requestedKeyFingerprint
      })
    )
  }
  return Either.right(undefined)
}
