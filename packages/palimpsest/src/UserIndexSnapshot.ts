import { createHash } from "node:crypto"
import { Data, Result, Schema } from "effect"
import { parseMemoryScope, type MemoryScope } from "./MemoryScope.js"
import { canonicalJson, type CanonicalJson } from "./SourceIdentity.js"

const SNAPSHOT_DESCRIPTOR_FORMAT = "palimpsest.user-index-snapshot.v1"

/**
 * Inputs that fix the identity of one immutable per-user projection (D1,
 * ADR-0003). `sourceCommitIds` is the ordered set of committed source-revision
 * commit ids the projection was built from; reordering produces a different
 * snapshot.
 */
export interface CreateUserIndexSnapshot {
  readonly scope: MemoryScope
  readonly indexGenerationId: string
  readonly canonicalViewId: string
  readonly sourceCommitIds: ReadonlyArray<string>
  readonly manifestSchemaVersion: number
}

/**
 * Content-addressed snapshot identity. `canonicalJson` is the descriptor byte
 * form hashed into `id` and persisted by the manifest; `sourceRevisionsHash`
 * names the ordered revision set alone so the manifest can index coverage
 * without decoding the descriptor.
 */
export interface UserIndexSnapshot extends CreateUserIndexSnapshot {
  readonly id: string
  readonly sourceRevisionsHash: string
  readonly canonicalJson: string
}

export class InvalidUserIndexSnapshot extends Data.TaggedError("InvalidUserIndexSnapshot")<{
  readonly reason: "invalidEncoding" | "identifierMismatch"
}> {
  override get message(): string {
    return `Invalid user index snapshot: ${this.reason}`
  }
}

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex")

const descriptorFor = (fields: {
  readonly canonicalViewId: string
  readonly indexGenerationId: string
  readonly manifestSchemaVersion: number
  readonly sourceCommitIds: ReadonlyArray<string>
  readonly tenantId: string
  readonly uid: string
}): CanonicalJson => ({
  canonical_view_id: fields.canonicalViewId,
  format: SNAPSHOT_DESCRIPTOR_FORMAT,
  index_generation_id: fields.indexGenerationId,
  manifest_schema_version: fields.manifestSchemaVersion,
  source_commit_ids: fields.sourceCommitIds.map((commitId): CanonicalJson => commitId),
  tenant_id: fields.tenantId,
  uid: fields.uid
})

const snapshotFromSerialized = (
  fields: {
    readonly scope: MemoryScope
    readonly indexGenerationId: string
    readonly canonicalViewId: string
    readonly sourceCommitIds: ReadonlyArray<string>
    readonly manifestSchemaVersion: number
  },
  serialized: string
): UserIndexSnapshot => ({
  scope: fields.scope,
  indexGenerationId: fields.indexGenerationId,
  canonicalViewId: fields.canonicalViewId,
  sourceCommitIds: fields.sourceCommitIds,
  manifestSchemaVersion: fields.manifestSchemaVersion,
  id: `snapshot-v1-${sha256(serialized)}`,
  sourceRevisionsHash: sha256(
    canonicalJson(fields.sourceCommitIds.map((commitId): CanonicalJson => commitId))
  ),
  canonicalJson: serialized
})

const UserIndexSnapshotDescriptorSchema = Schema.Struct({
  canonical_view_id: Schema.String,
  format: Schema.Literal(SNAPSHOT_DESCRIPTOR_FORMAT),
  index_generation_id: Schema.String,
  manifest_schema_version: Schema.Number,
  source_commit_ids: Schema.Array(Schema.String),
  tenant_id: Schema.String,
  uid: Schema.String
})

/** Canonical descriptor shape, derived from its one schema codec. */
export type UserIndexSnapshotDescriptor = typeof UserIndexSnapshotDescriptorSchema.Type

const invalidEncoding = Result.fail(
  new InvalidUserIndexSnapshot({ reason: "invalidEncoding" })
)

export const parseUserIndexSnapshot = (
  id: string,
  serialized: string
): Result.Result<UserIndexSnapshot, InvalidUserIndexSnapshot> => {
  try {
    const decoded = Schema.decodeUnknownResult(UserIndexSnapshotDescriptorSchema)(
      JSON.parse(serialized)
    )
    if (Result.isFailure(decoded)) return invalidEncoding
    const descriptor = decoded.success
    const scope = parseMemoryScope(descriptor.tenant_id, descriptor.uid)
    if (Result.isFailure(scope)) return invalidEncoding
    if (
      descriptor.canonical_view_id.trim().length === 0 ||
      descriptor.index_generation_id.trim().length === 0 ||
      !Number.isSafeInteger(descriptor.manifest_schema_version) ||
      descriptor.manifest_schema_version < 1 ||
      descriptor.source_commit_ids.some((commitId) => commitId.trim().length === 0) ||
      new Set(descriptor.source_commit_ids).size !== descriptor.source_commit_ids.length
    ) {
      return invalidEncoding
    }
    const snapshot = snapshotFromSerialized(
      {
        scope: scope.success,
        indexGenerationId: descriptor.index_generation_id,
        canonicalViewId: descriptor.canonical_view_id,
        sourceCommitIds: descriptor.source_commit_ids,
        manifestSchemaVersion: descriptor.manifest_schema_version
      },
      canonicalJson(
        descriptorFor({
          canonicalViewId: descriptor.canonical_view_id,
          indexGenerationId: descriptor.index_generation_id,
          manifestSchemaVersion: descriptor.manifest_schema_version,
          sourceCommitIds: descriptor.source_commit_ids,
          tenantId: descriptor.tenant_id,
          uid: descriptor.uid
        })
      )
    )
    if (snapshot.canonicalJson !== serialized) return invalidEncoding
    if (snapshot.id !== id) {
      return Result.fail(new InvalidUserIndexSnapshot({ reason: "identifierMismatch" }))
    }
    return Result.succeed(snapshot)
  } catch {
    return invalidEncoding
  }
}

/**
 * Construct a valid content-addressed snapshot from already-parsed scope data.
 * The same descriptor parser used at the persistence boundary enforces every
 * snapshot invariant before the value can escape this module.
 */
export const createUserIndexSnapshot = (
  input: CreateUserIndexSnapshot
): Result.Result<UserIndexSnapshot, InvalidUserIndexSnapshot> => {
  const serialized = canonicalJson(
    descriptorFor({
      canonicalViewId: input.canonicalViewId,
      indexGenerationId: input.indexGenerationId,
      manifestSchemaVersion: input.manifestSchemaVersion,
      sourceCommitIds: input.sourceCommitIds,
      tenantId: input.scope.tenantId,
      uid: input.scope.uid
    })
  )
  const candidate = snapshotFromSerialized(input, serialized)
  return parseUserIndexSnapshot(candidate.id, serialized)
}
