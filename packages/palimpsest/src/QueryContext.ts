import { Config, Context, Data, Effect, Layer, Result } from "effect"
import {
  IngestManifest,
  type ActiveIndexSnapshot,
  type IngestManifestError,
  type UserIndexSnapshotRecord,
  type UserIndexSnapshotScope
} from "./IngestManifest.js"
import { parseMemoryScope, type MemoryScope } from "./MemoryScope.js"
import { DEFAULT_TEMPORAL_PERSPECTIVE, type TemporalPerspective } from "./TimeScope.js"
import type { UserIndexSnapshot } from "./UserIndexSnapshot.js"

const queryPrincipalBrand = Symbol("palimpsest.QueryPrincipal")

/**
 * Explicit caller claims for one retrieval/hydration request. Pre-S11 the
 * provider below supplies these from explicit configuration; S11 replaces the
 * provider with verified credentials without changing this boundary.
 */
export interface QueryPrincipal {
  readonly tenantId: string
  readonly subject: string
  readonly [queryPrincipalBrand]: "QueryPrincipal"
}

export class InvalidQueryPrincipal extends Data.TaggedError("InvalidQueryPrincipal")<{
  readonly field: "tenantId" | "subject"
  readonly reason: string
}> {
  override get message(): string {
    return `invalid query principal: ${this.field} ${this.reason}`
  }
}

export const parseQueryPrincipal = (
  tenantId: string,
  subject: string
): Result.Result<QueryPrincipal, InvalidQueryPrincipal> => {
  if (tenantId.trim().length === 0) {
    return Result.fail(new InvalidQueryPrincipal({ field: "tenantId", reason: "must not be empty" }))
  }
  if (subject.trim().length === 0) {
    return Result.fail(new InvalidQueryPrincipal({ field: "subject", reason: "must not be empty" }))
  }
  return Result.succeed({
    tenantId: tenantId.trim(),
    subject: subject.trim(),
    [queryPrincipalBrand]: "QueryPrincipal"
  })
}

/** The scope never recorded revisions, snapshots, or manifest activity. */
export class MemoryScopeNotFound extends Data.TaggedError("MemoryScopeNotFound")<{
  readonly tenant: string
  readonly uid: string
}> {
  override get message(): string {
    return `unknown memory scope ${this.tenant}/${this.uid}`
  }
}

/** The scope is known but currently has no query-visible snapshot. */
export class NoActiveSnapshot extends Data.TaggedError("NoActiveSnapshot")<{
  readonly tenant: string
  readonly uid: string
}> {
  override get message(): string {
    return `no active snapshot for ${this.tenant}/${this.uid}`
  }
}

/** The active pointer names a record that cannot serve queries. */
export class ActiveSnapshotCorrupt extends Data.TaggedError("ActiveSnapshotCorrupt")<{
  readonly snapshotId: string
  readonly reason: "stateNotActive" | "scopeMismatch" | "missingVerificationEvidence"
  readonly detail: string
}> {
  override get message(): string {
    return `active snapshot ${this.snapshotId} is corrupt: ${this.reason} (${this.detail})`
  }
}

/** Where one snapshot candidate's bytes come from: a committed revision inside the bound snapshot. */
export interface ClaimProvenance {
  readonly snapshotId: string
  readonly commitId: string
  readonly sourceDigest: string
  readonly logicalSessionId: string
  readonly indexGenerationId: string
  readonly canonicalViewId: string
}

/** Where one hydrated span's bytes come from, down to the stored source turn. */
export interface SpanProvenance {
  readonly snapshotId: string
  readonly commitId: string
  readonly sourceDigest: string
  readonly logicalSessionId: string
  readonly sourceTurnKey: string
}

/** A key or candidate from outside the bound snapshot reached a snapshot-scoped read. */
export class SnapshotScopeViolation extends Data.TaggedError("SnapshotScopeViolation")<{
  readonly expectedSnapshotId: string
  readonly key: string
  readonly reason: "foreignSnapshot" | "foreignScope" | "missingProvenance"
}> {
  override get message(): string {
    return `snapshot scope violation: ${this.reason} for ${this.key}, expected ${this.expectedSnapshotId}`
  }
}

/** The snapshot graph disagrees with the manifest record the request bound to. */
export class SnapshotGraphMismatch extends Data.TaggedError("SnapshotGraphMismatch")<{
  readonly snapshotId: string
  readonly reason:
    | "missingRoot"
    | "rootMismatch"
    | "graphFormatMismatch"
    | "revisionsHashMismatch"
    | "countsMismatch"
    | "uncoveredRevision"
    | "evidenceMismatch"
    | "sourceTurnMismatch"
  readonly detail: string
}> {
  override get message(): string {
    return `snapshot graph mismatch for ${this.snapshotId}: ${this.reason} (${this.detail})`
  }
}

/**
 * The immutable binding for one retrieval/hydration request: the validated
 * scope plus the single active snapshot every read in the request must use.
 * Later activation never mutates this value; new requests resolve again.
 */
export interface QueryContext {
  readonly principal: QueryPrincipal
  readonly scope: MemoryScope
  readonly snapshot: UserIndexSnapshot
  readonly record: UserIndexSnapshotRecord
  readonly manifestVersion: number
  readonly activatedAtMs: number
  /** Coverage observed atomically with the active pointer. */
  readonly coverage: {
    readonly revisionsCovered: number
    readonly scopeRevisions: number
    readonly uncommitted: number
  }
  readonly perspective: TemporalPerspective
  /** S05A fixes snapshot reads at COMMITTED; S13 may generalize per-operation minimums. */
  readonly requiredWatermark: "COMMITTED"
  readonly asOf?: number
  readonly causalFloor?: string
}

export interface ResolveQueryContextInput {
  readonly principal: QueryPrincipal
  readonly requestedUid: string
  readonly perspective?: TemporalPerspective
  readonly asOf?: number
  readonly causalFloor?: string
}

/** Pure fail-closed validation of the record behind the active pointer. */
export const validateActiveSnapshot = (
  scope: MemoryScope,
  active: ActiveIndexSnapshot
): Result.Result<UserIndexSnapshotRecord, ActiveSnapshotCorrupt> => {
  const record = active.record
  if (record.state !== "ACTIVE") {
    return Result.fail(
      new ActiveSnapshotCorrupt({
        snapshotId: record.snapshot.id,
        reason: "stateNotActive",
        detail: record.state
      })
    )
  }
  if (
    record.snapshot.scope.tenantId !== scope.tenantId || record.snapshot.scope.uid !== scope.uid
  ) {
    return Result.fail(
      new ActiveSnapshotCorrupt({
        snapshotId: record.snapshot.id,
        reason: "scopeMismatch",
        detail: `${record.snapshot.scope.tenantId}/${record.snapshot.scope.uid}`
      })
    )
  }
  if (
    record.verificationDigest === null || record.graphRoots === null || record.counts === null
  ) {
    return Result.fail(
      new ActiveSnapshotCorrupt({
        snapshotId: record.snapshot.id,
        reason: "missingVerificationEvidence",
        detail: record.snapshot.id
      })
    )
  }
  return Result.succeed(record)
}

/**
 * Resolve principal claims plus the requested user into one immutable
 * snapshot binding. Unknown scopes fail distinctly from known scopes with no
 * active snapshot so callers never report either case as an absence.
 */
export const resolveQueryContext = (
  input: ResolveQueryContextInput
): Effect.Effect<
  QueryContext,
  NoActiveSnapshot | MemoryScopeNotFound | ActiveSnapshotCorrupt | IngestManifestError,
  IngestManifest
> =>
  Effect.gen(function* () {
    const manifest = yield* IngestManifest
    const parsed = parseMemoryScope(input.principal.tenantId, input.requestedUid)
    if (Result.isFailure(parsed)) return yield* Effect.fail(parsed.failure)
    const scope = parsed.success
    const snapshotScope: UserIndexSnapshotScope = { tenant: scope.tenantId, uid: scope.uid }
    const binding = yield* manifest.readActiveQuerySnapshotBinding(snapshotScope)
    if (binding.active === null) {
      return yield* reportMissingActiveSnapshot(binding, scope)
    }
    const active = binding.active
    const record = validateActiveSnapshot(scope, active)
    if (Result.isFailure(record)) return yield* Effect.fail(record.failure)
    return {
      principal: input.principal,
      scope,
      snapshot: record.success.snapshot,
      record: record.success,
      manifestVersion: active.manifestVersion,
      activatedAtMs: active.activatedAtMs,
      coverage: {
        revisionsCovered: record.success.snapshot.sourceCommitIds.length,
        scopeRevisions: binding.scopeRevisions,
        uncommitted: binding.uncommittedRevisions
      },
      perspective: input.perspective ?? DEFAULT_TEMPORAL_PERSPECTIVE,
      requiredWatermark: "COMMITTED",
      ...(input.asOf !== undefined && { asOf: input.asOf }),
      ...(input.causalFloor !== undefined && { causalFloor: input.causalFloor })
    }
  })

const reportMissingActiveSnapshot = (
  binding: {
    readonly snapshots: number
    readonly scopeRevisions: number
    readonly manifestVersion: number
  },
  scope: MemoryScope
): Effect.Effect<never, NoActiveSnapshot | MemoryScopeNotFound> =>
  Effect.gen(function* () {
    if (binding.snapshots > 0) {
      return yield* Effect.fail(
        new NoActiveSnapshot({ tenant: scope.tenantId, uid: scope.uid })
      )
    }
    if (binding.scopeRevisions > 0) {
      return yield* Effect.fail(
        new NoActiveSnapshot({ tenant: scope.tenantId, uid: scope.uid })
      )
    }
    if (binding.manifestVersion > 0) {
      return yield* Effect.fail(
        new NoActiveSnapshot({ tenant: scope.tenantId, uid: scope.uid })
      )
    }
    return yield* Effect.fail(
      new MemoryScopeNotFound({ tenant: scope.tenantId, uid: scope.uid })
    )
  })

export interface QueryPrincipalProviderService {
  readonly currentPrincipal: Effect.Effect<QueryPrincipal, InvalidQueryPrincipal>
}

export class QueryPrincipalProvider extends Context.Service<
  QueryPrincipalProvider,
  QueryPrincipalProviderService
>()("palimpsest/QueryPrincipalProvider") {
  static readonly layerStatic = (
    tenantId: string,
    subject: string
  ): Layer.Layer<QueryPrincipalProvider, never, never> =>
    Layer.succeed(QueryPrincipalProvider, {
      currentPrincipal: Effect.suspend(() => {
        const parsed = parseQueryPrincipal(tenantId, subject)
        return parsed._tag === "Failure" ? Effect.fail(parsed.failure) : Effect.succeed(parsed.success)
      })
    })

  static readonly layerFromConfig: Layer.Layer<QueryPrincipalProvider, Config.ConfigError, never> =
    Layer.effect(
      QueryPrincipalProvider,
      Effect.gen(function* () {
        const tenantId = yield* Config.string("PALIMPSEST_QUERY_TENANT")
        const subject = yield* Config.string("PALIMPSEST_QUERY_SUBJECT")
        return {
          currentPrincipal: Effect.suspend(() => {
            const parsed = parseQueryPrincipal(tenantId, subject)
            return parsed._tag === "Failure"
              ? Effect.fail(parsed.failure)
              : Effect.succeed(parsed.success)
          })
        }
      })
    )
}

/** Explicit test/dev principal with no defaults and no ambient tenant. */
export const layerStaticQueryPrincipal = QueryPrincipalProvider.layerStatic

/** Pre-S11 server wiring: explicit config, replaced by verified credentials in S11. */
export const layerQueryPrincipalFromConfig = QueryPrincipalProvider.layerFromConfig
