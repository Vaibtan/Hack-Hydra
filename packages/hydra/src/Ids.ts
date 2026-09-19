import { createHash } from "node:crypto"
import { Result } from "effect"
import { HydraIdentityIntegrityError } from "./Errors.js"

export type NumericIdForKey = (key: string) => number

export interface GraphIdentity {
  readonly key: string
  readonly numericId: number
}

export interface GraphIdentityRegistry {
  readonly claimRelationship: (key: string) => Result.Result<GraphIdentity, HydraIdentityIntegrityError>
  readonly claimVertex: (key: string) => Result.Result<GraphIdentity, HydraIdentityIntegrityError>
}

export interface VerifyStoredGraphIdentity {
  readonly kind: "relationship" | "vertex"
  readonly numericId: number
  readonly requestedKey: string
  readonly storedKey: string | null
  readonly numericIdForKey?: NumericIdForKey
}

const keyFingerprint = (key: string): string =>
  createHash("sha256").update(key, "utf8").digest("hex")

export const vertexId = (key: string): number => {
  const digest = createHash("sha256").update(key, "utf8").digest()
  return Number(digest.readBigUInt64BE(0) >> 11n)
}

export const edgeId = (srcKey: string, relType: string, dstKey: string): number =>
  vertexId(`${srcKey}|${relType}|${dstKey}`)

const claim = (
  kind: "relationship" | "vertex",
  identities: Map<number, string>,
  key: string,
  numericIdForKey: NumericIdForKey
): Result.Result<GraphIdentity, HydraIdentityIntegrityError> => {
  const numericId = numericIdForKey(key)
  if (!Number.isSafeInteger(numericId) || numericId < 0) {
    return Result.fail(
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
    return Result.fail(
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
  return Result.succeed({ key, numericId })
}

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

export const verifyStoredGraphIdentity = (
  input: VerifyStoredGraphIdentity
): Result.Result<void, HydraIdentityIntegrityError> => {
  const requestedKeyFingerprint = keyFingerprint(input.requestedKey)
  if (input.storedKey === null) {
    return Result.fail(
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
    return Result.fail(
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
    return Result.fail(
      new HydraIdentityIntegrityError({
        kind: input.kind,
        reason: "numericMismatch",
        numericId: input.numericId,
        existingKeyFingerprint: keyFingerprint(input.storedKey),
        requestedKeyFingerprint
      })
    )
  }
  return Result.succeed(undefined)
}
