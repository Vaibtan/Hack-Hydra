import { Data, Result } from "effect"

const memoryScopeBrand: unique symbol = Symbol("palimpsest.MemoryScope")

/**
 * The tenant-scoped identity of one independent history in the new
 * transactional plane (D1, S01). Constructible only through
 * {@link parseMemoryScope} or {@link memoryScopeFromRevision}, so no
 * new-plane graph key helper can be called with a bare user id.
 */
export interface MemoryScope {
  readonly tenantId: string
  readonly uid: string
  readonly [memoryScopeBrand]: "MemoryScope"
}

export class InvalidMemoryScope extends Data.TaggedError("InvalidMemoryScope")<{
  readonly field: "tenantId" | "uid"
  readonly reason: string
}> {
  override get message(): string {
    return `Invalid memory scope ${this.field}: ${this.reason}`
  }
}

/** Non-empty scope segments; length-prefix framing makes separators unambiguous. */
export const parseMemoryScope = (tenantId: string, uid: string): Result.Result<MemoryScope, InvalidMemoryScope> => {
  if (tenantId.trim().length === 0) {
    return Result.fail(new InvalidMemoryScope({ field: "tenantId", reason: "must not be empty" }))
  }
  if (uid.trim().length === 0) {
    return Result.fail(new InvalidMemoryScope({ field: "uid", reason: "must not be empty" }))
  }
  return Result.succeed({ tenantId, uid, [memoryScopeBrand]: "MemoryScope" })
}

/**
 * Scope for an already manifest-validated revision. Manifest `begin()`
 * rejects empty tenant/uid, so a violation here is a programming error, not
 * an expected failure.
 */
export const memoryScopeFromRevision = (revision: {
  readonly tenant: string
  readonly uid: string
}): MemoryScope => {
  const parsed = parseMemoryScope(revision.tenant, revision.uid)
  if (parsed._tag === "Failure") throw parsed.failure
  return parsed.success
}

/**
 * Canonical length-prefixed framing of one variable key segment, using UTF-8
 * byte length so multibyte text cannot shift a boundary. Fixed labels
 * (`srcsess`, `turn`, `index`, ...) stay bare: they are code constants, not
 * caller-controlled values.
 */
export const frameSegment = (value: string): string => `${Buffer.byteLength(value, "utf8")}:${value}`

/**
 * Leading segment of every new-plane graph key. Equal user ids in different
 * tenants produce different keys by construction, and a tenant or user id
 * containing `|` or `:` cannot collide with another tenant/user pair because
 * both segments carry their own lengths.
 */
export const scopePrefix = (scope: MemoryScope): string =>
  `t${frameSegment(scope.tenantId)}|u${frameSegment(scope.uid)}`

/** Tenant-scoped root key for the new transactional memory plane. */
export const memoryScopeKey = (scope: MemoryScope): string => `${scopePrefix(scope)}|memory`
