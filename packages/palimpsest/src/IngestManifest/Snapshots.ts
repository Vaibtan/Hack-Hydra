import type { DatabaseSync } from "node:sqlite"
import { Effect, Result, Schema } from "effect"
import { InvalidMemoryScope, parseMemoryScope, type MemoryScope } from "../MemoryScope.js"
import { canonicalJson, type CanonicalJson } from "../SourceIdentity.js"
import { InvalidUserIndexSnapshot, parseUserIndexSnapshot } from "../UserIndexSnapshot.js"
import {
  integer,
  nullableText,
  readTransaction,
  selectRevisionByCommitId,
  text,
  transaction,
  type DatabaseRow
} from "./Rows.js"
import {
  EntityCanonicalViewNotFound,
  IndexGenerationNotFound,
  IngestManifestUnavailable,
  InvalidSnapshotTransition,
  InvalidSnapshotUpdate,
  SnapshotActivePointerConflict,
  SnapshotActivationConflict,
  SnapshotRevisionCoverageMismatch,
  SnapshotRevisionNotCommitted,
  SnapshotScopeMismatch,
  SnapshotVerificationConflict,
  SNAPSHOT_STATES,
  UserIndexSnapshotBindingMismatch,
  UserIndexSnapshotConflict,
  UserIndexSnapshotNotFound,
  type ActivateIndexSnapshot,
  type ActiveIndexSnapshot,
  type ActiveQuerySnapshotBinding,
  type CommitAndActivateIndexSnapshot,
  type FailUserIndexSnapshot,
  type RegisterUserIndexSnapshot,
  type SnapshotProjectionCounts,
  type SnapshotState,
  type UserIndexSnapshotRecord,
  type UserIndexSnapshotScope,
  type VerifyUserIndexSnapshot
} from "./Types.js"

export interface SnapshotOperations {
  /**
   * Persist one content-addressed snapshot identity as a BUILDING row.
   * Re-registering the same identity is idempotent; re-registering a FAILED
   * row re-opens it as BUILDING with an incremented build attempt.
   */
  readonly registerUserIndexSnapshot: (
    input: RegisterUserIndexSnapshot
  ) => Effect.Effect<
    UserIndexSnapshotRecord,
    | InvalidUserIndexSnapshot
    | IndexGenerationNotFound
    | EntityCanonicalViewNotFound
    | UserIndexSnapshotBindingMismatch
    | UserIndexSnapshotConflict
    | IngestManifestUnavailable
  >
  /**
   * Record build read-back evidence and move BUILDING -> VERIFIED. Repeating
   * the same evidence is idempotent; different evidence conflicts.
   */
  readonly verifyUserIndexSnapshot: (
    input: VerifyUserIndexSnapshot
  ) => Effect.Effect<
    UserIndexSnapshotRecord,
    | UserIndexSnapshotNotFound
    | InvalidSnapshotTransition
    | InvalidSnapshotUpdate
    | SnapshotVerificationConflict
    | IngestManifestUnavailable
  >
  /** Move BUILDING -> FAILED with a failure code; same-code retry is idempotent. */
  readonly failUserIndexSnapshot: (
    input: FailUserIndexSnapshot
  ) => Effect.Effect<
    UserIndexSnapshotRecord,
    | UserIndexSnapshotNotFound
    | InvalidSnapshotTransition
    | InvalidSnapshotUpdate
    | IngestManifestUnavailable
  >
  /** Reconstruct one snapshot's full content from its manifest row. */
  readonly readUserIndexSnapshot: (
    snapshotId: string
  ) => Effect.Effect<UserIndexSnapshotRecord | null, IngestManifestUnavailable>
  /** List every recorded snapshot for one scope, oldest first. */
  readonly listUserIndexSnapshots: (
    scope: UserIndexSnapshotScope
  ) => Effect.Effect<ReadonlyArray<UserIndexSnapshotRecord>, InvalidMemoryScope | IngestManifestUnavailable>
  /** Resolve the scope's active pointer to its snapshot record, or null when none was activated. */
  readonly readActiveIndexSnapshot: (
    scope: UserIndexSnapshotScope
  ) => Effect.Effect<ActiveIndexSnapshot | null, InvalidMemoryScope | IngestManifestUnavailable>
  /**
   * Resolve the active pointer, manifest version, and coverage counters from
   * one SQLite read transaction for request-scoped query binding.
   */
  readonly readActiveQuerySnapshotBinding: (
    scope: UserIndexSnapshotScope
  ) => Effect.Effect<ActiveQuerySnapshotBinding, InvalidMemoryScope | IngestManifestUnavailable>
  /**
   * One SQLite transaction that validates a VERIFIED (or previously
   * SUPERSEDED) snapshot — scope match, every listed revision COMMITTED, and
   * `expectedManifestVersion` equal to the scope's committed manifest version,
   * and `expectedActiveSnapshotId` equal to the current pointer — then atomically
   * supersedes the current active snapshot and moves the pointer. The previous
   * active snapshot stays active until this transaction commits. Repeating an
   * already-activated snapshot is idempotent. Stale manifest and pointer
   * expectations fail explicitly, so only one distinct competing activation
   * succeeds from a shared observed state.
   */
  readonly activateIndexSnapshot: (
    input: ActivateIndexSnapshot
  ) => Effect.Effect<
    ActiveIndexSnapshot,
    | InvalidMemoryScope
    | InvalidSnapshotUpdate
    | UserIndexSnapshotNotFound
    | SnapshotScopeMismatch
    | InvalidSnapshotTransition
    | SnapshotRevisionNotCommitted
    | SnapshotRevisionCoverageMismatch
    | SnapshotActivePointerConflict
    | SnapshotActivationConflict
    | IngestManifestUnavailable
  >
  /**
   * One SQLite transaction that runs the S04 terminal commit: every listed
   * revision still parked at CONSOLIDATED (without a non-retryable failure)
   * advances to COMMITTED — bumping the scope manifest version per commit —
   * then the same validations and pointer compare-and-swap as `activate` run.
   * `expectedManifestVersion` is checked against the pre-commit version, so the
   * caller proves the snapshot was verified against this exact revision set.
   * Repeating an already-activated snapshot is idempotent.
   */
  readonly commitAndActivateIndexSnapshot: (
    input: CommitAndActivateIndexSnapshot
  ) => Effect.Effect<
    ActiveIndexSnapshot,
    | InvalidMemoryScope
    | InvalidSnapshotUpdate
    | UserIndexSnapshotNotFound
    | SnapshotScopeMismatch
    | InvalidSnapshotTransition
    | SnapshotRevisionNotCommitted
    | SnapshotRevisionCoverageMismatch
    | SnapshotActivePointerConflict
    | SnapshotActivationConflict
    | IngestManifestUnavailable
  >
}

const GraphRootsSchema = Schema.Array(Schema.String)
const SnapshotCountsSchema = Schema.Struct({
  relationships: Schema.Number,
  source_revisions: Schema.Number,
  vertices: Schema.Number
})

const isSnapshotState = (value: string): value is SnapshotState =>
  SNAPSHOT_STATES.some((state) => state === value)

const scopeFor = (input: UserIndexSnapshotScope): MemoryScope => {
  const parsed = parseMemoryScope(input.tenant, input.uid)
  if (Result.isFailure(parsed)) throw parsed.failure
  return parsed.success
}

const decodeGraphRoots = (snapshotId: string, serialized: string): ReadonlyArray<string> => {
  const decoded = Schema.decodeUnknownResult(GraphRootsSchema)(JSON.parse(serialized))
  if (Result.isFailure(decoded)) throw new Error(`snapshot ${snapshotId} graph roots were invalid`)
  const roots = decoded.success
  if (roots.some((root) => root.trim().length === 0)) {
    throw new Error(`snapshot ${snapshotId} graph roots were invalid`)
  }
  return roots
}

const decodeCounts = (snapshotId: string, serialized: string): SnapshotProjectionCounts => {
  const decoded = Schema.decodeUnknownResult(SnapshotCountsSchema)(JSON.parse(serialized))
  if (Result.isFailure(decoded)) throw new Error(`snapshot ${snapshotId} counts were invalid`)
  const counts = decoded.success
  if (
    !Number.isSafeInteger(counts.source_revisions) ||
    counts.source_revisions < 0 ||
    !Number.isSafeInteger(counts.vertices) ||
    counts.vertices < 0 ||
    !Number.isSafeInteger(counts.relationships) ||
    counts.relationships < 0
  ) {
    throw new Error(`snapshot ${snapshotId} counts were invalid`)
  }
  return {
    sourceRevisions: counts.source_revisions,
    vertices: counts.vertices,
    relationships: counts.relationships
  }
}

const encodeCounts = (counts: SnapshotProjectionCounts): string =>
  canonicalJson({
    relationships: counts.relationships,
    source_revisions: counts.sourceRevisions,
    vertices: counts.vertices
  })

const sameRoots = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length && left.every((root, index) => root === right[index])

const sameCounts = (left: SnapshotProjectionCounts, right: SnapshotProjectionCounts): boolean =>
  left.sourceRevisions === right.sourceRevisions &&
  left.vertices === right.vertices &&
  left.relationships === right.relationships

const SNAPSHOT_COLUMNS = `snapshot_id, tenant, uid, generation_id, canonical_view_id,
  manifest_schema_version, source_revisions_hash, source_revision_count, state, build_attempt,
  verification_digest, graph_roots_json, counts_json, failure_code, canonical_json,
  created_at_ms, updated_at_ms`

const decodeRecord = (database: DatabaseSync, row: DatabaseRow): UserIndexSnapshotRecord => {
  const snapshotId = text(row, "snapshot_id")
  const parsed = parseUserIndexSnapshot(snapshotId, text(row, "canonical_json"))
  if (Result.isFailure(parsed)) throw new Error(`stored user index snapshot ${snapshotId} was invalid`)
  const snapshot = parsed.success
  if (
    text(row, "tenant") !== snapshot.scope.tenantId ||
    text(row, "uid") !== snapshot.scope.uid ||
    text(row, "generation_id") !== snapshot.indexGenerationId ||
    text(row, "canonical_view_id") !== snapshot.canonicalViewId ||
    integer(row, "manifest_schema_version") !== snapshot.manifestSchemaVersion ||
    text(row, "source_revisions_hash") !== snapshot.sourceRevisionsHash ||
    integer(row, "source_revision_count") !== snapshot.sourceCommitIds.length
  ) {
    throw new Error(`stored user index snapshot ${snapshotId} had inconsistent identity columns`)
  }
  const revisionRows = database
    .prepare(
      `SELECT commit_id FROM user_index_snapshot_revisions WHERE snapshot_id = ? ORDER BY position ASC`
    )
    .all(snapshotId)
  const storedCommitIds = revisionRows.map((revision) => text(revision, "commit_id"))
  if (
    storedCommitIds.length !== snapshot.sourceCommitIds.length ||
    storedCommitIds.some((commitId, index) => commitId !== snapshot.sourceCommitIds[index])
  ) {
    throw new Error(`stored user index snapshot ${snapshotId} had inconsistent revisions`)
  }
  const state = text(row, "state")
  if (!isSnapshotState(state)) throw new Error(`stored user index snapshot ${snapshotId} had invalid state`)
  const verificationDigest = nullableText(row, "verification_digest")
  const rootsJson = nullableText(row, "graph_roots_json")
  const countsJson = nullableText(row, "counts_json")
  const failureCode = nullableText(row, "failure_code")
  const expectsEvidence = state === "VERIFIED" || state === "ACTIVE" || state === "SUPERSEDED"
  if (expectsEvidence && (verificationDigest === null || rootsJson === null || countsJson === null)) {
    throw new Error(`stored user index snapshot ${snapshotId} missed verification evidence`)
  }
  if (
    (state === "BUILDING" || state === "FAILED") &&
    (verificationDigest !== null || rootsJson !== null || countsJson !== null)
  ) {
    throw new Error(`stored user index snapshot ${snapshotId} had evidence without verification`)
  }
  if (state === "BUILDING" && failureCode !== null) {
    throw new Error(`stored user index snapshot ${snapshotId} had a failure without failing`)
  }
  if (state === "FAILED" && failureCode === null) {
    throw new Error(`stored user index snapshot ${snapshotId} failed without a code`)
  }
  return {
    snapshot,
    state,
    buildAttempt: integer(row, "build_attempt"),
    verificationDigest,
    graphRoots: rootsJson === null ? null : decodeGraphRoots(snapshotId, rootsJson),
    counts: countsJson === null ? null : decodeCounts(snapshotId, countsJson),
    failureCode,
    createdAtMs: integer(row, "created_at_ms"),
    updatedAtMs: integer(row, "updated_at_ms")
  }
}

const selectSnapshotRecord = (
  database: DatabaseSync,
  snapshotId: string
): UserIndexSnapshotRecord | undefined => {
  const row = database
    .prepare(`SELECT ${SNAPSHOT_COLUMNS} FROM user_index_snapshots WHERE snapshot_id = ?`)
    .get(snapshotId)
  return row === undefined ? undefined : decodeRecord(database, row)
}

const register = (database: DatabaseSync, input: RegisterUserIndexSnapshot): UserIndexSnapshotRecord => {
  const parsed = parseUserIndexSnapshot(input.snapshot.id, input.snapshot.canonicalJson)
  if (Result.isFailure(parsed)) throw parsed.failure
  const snapshot = parsed.success
  const existing = selectSnapshotRecord(database, snapshot.id)
  if (existing !== undefined) {
    if (existing.snapshot.canonicalJson !== snapshot.canonicalJson) {
      throw new UserIndexSnapshotConflict({ snapshotId: snapshot.id })
    }
    if (existing.state !== "FAILED") return existing
    database
      .prepare(
        `UPDATE user_index_snapshots
            SET state = 'BUILDING', build_attempt = build_attempt + 1,
                verification_digest = NULL, graph_roots_json = NULL, counts_json = NULL,
                failure_code = NULL, updated_at_ms = ?
          WHERE snapshot_id = ?`
      )
      .run(Date.now(), snapshot.id)
    const reopened = selectSnapshotRecord(database, snapshot.id)
    if (reopened === undefined) throw new Error("reopened user index snapshot was not readable")
    return reopened
  }

  const generation = database
    .prepare(`SELECT generation_id FROM index_generations WHERE generation_id = ?`)
    .get(snapshot.indexGenerationId)
  if (generation === undefined) {
    throw new IndexGenerationNotFound({ generationId: snapshot.indexGenerationId })
  }
  const view = database
    .prepare(
      `SELECT view_id FROM entity_canonical_views WHERE tenant = ? AND uid = ? AND view_id = ?`
    )
    .get(snapshot.scope.tenantId, snapshot.scope.uid, snapshot.canonicalViewId)
  if (view === undefined) {
    throw new EntityCanonicalViewNotFound({
      tenant: snapshot.scope.tenantId,
      uid: snapshot.scope.uid,
      viewId: snapshot.canonicalViewId
    })
  }
  for (const commitId of snapshot.sourceCommitIds) {
    const revision = selectRevisionByCommitId(database, commitId)
    if (revision === undefined) {
      throw new UserIndexSnapshotBindingMismatch({
        snapshotId: snapshot.id,
        commitId,
        reason: "unknownRevision"
      })
    }
    if (revision.tenant !== snapshot.scope.tenantId || revision.uid !== snapshot.scope.uid) {
      throw new UserIndexSnapshotBindingMismatch({
        snapshotId: snapshot.id,
        commitId,
        reason: "scopeMismatch"
      })
    }
  }

  const now = Date.now()
  database
    .prepare(
      `INSERT INTO user_index_snapshots (
        snapshot_id, tenant, uid, generation_id, canonical_view_id, manifest_schema_version,
        source_revisions_hash, source_revision_count, state, build_attempt, canonical_json,
        created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'BUILDING', 1, ?, ?, ?)`
    )
    .run(
      snapshot.id,
      snapshot.scope.tenantId,
      snapshot.scope.uid,
      snapshot.indexGenerationId,
      snapshot.canonicalViewId,
      snapshot.manifestSchemaVersion,
      snapshot.sourceRevisionsHash,
      snapshot.sourceCommitIds.length,
      snapshot.canonicalJson,
      now,
      now
    )
  const insertRevision = database.prepare(
    `INSERT INTO user_index_snapshot_revisions (snapshot_id, position, commit_id) VALUES (?, ?, ?)`
  )
  snapshot.sourceCommitIds.forEach((commitId, position) => {
    insertRevision.run(snapshot.id, position, commitId)
  })
  const stored = selectSnapshotRecord(database, snapshot.id)
  if (stored === undefined) throw new Error("inserted user index snapshot was not readable")
  return stored
}

const VERIFICATION_DIGEST = /^[a-f0-9]{64}$/

const verify = (database: DatabaseSync, input: VerifyUserIndexSnapshot): UserIndexSnapshotRecord => {
  const record = selectSnapshotRecord(database, input.snapshotId)
  if (record === undefined) throw new UserIndexSnapshotNotFound({ snapshotId: input.snapshotId })
  if (!VERIFICATION_DIGEST.test(input.verificationDigest)) {
    throw new InvalidSnapshotUpdate({
      snapshotId: input.snapshotId,
      field: "verificationDigest",
      reason: "must be a lowercase SHA-256 hex digest"
    })
  }
  if (input.graphRoots.some((root) => root.trim().length === 0)) {
    throw new InvalidSnapshotUpdate({
      snapshotId: input.snapshotId,
      field: "graphRoots",
      reason: "roots must not be empty"
    })
  }
  for (const field of ["sourceRevisions", "vertices", "relationships"] as const) {
    const value = input.counts[field]
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new InvalidSnapshotUpdate({
        snapshotId: input.snapshotId,
        field: "counts",
        reason: `${field} must be a non-negative safe integer`
      })
    }
  }
  if (input.counts.sourceRevisions !== record.snapshot.sourceCommitIds.length) {
    throw new InvalidSnapshotUpdate({
      snapshotId: input.snapshotId,
      field: "counts",
      reason: "sourceRevisions must equal the snapshot's committed revision count"
    })
  }
  if (record.state === "VERIFIED") {
    if (
      record.verificationDigest === input.verificationDigest &&
      record.graphRoots !== null &&
      record.counts !== null &&
      sameRoots(record.graphRoots, input.graphRoots) &&
      sameCounts(record.counts, input.counts)
    ) {
      return record
    }
    throw new SnapshotVerificationConflict({ snapshotId: input.snapshotId })
  }
  if (record.state !== "BUILDING") {
    throw new InvalidSnapshotTransition({
      snapshotId: input.snapshotId,
      current: record.state,
      requested: "VERIFIED"
    })
  }
  database
    .prepare(
      `UPDATE user_index_snapshots
          SET state = 'VERIFIED', verification_digest = ?, graph_roots_json = ?, counts_json = ?,
              updated_at_ms = ?
        WHERE snapshot_id = ?`
    )
    .run(
      input.verificationDigest,
      canonicalJson(input.graphRoots.map((root): CanonicalJson => root)),
      encodeCounts(input.counts),
      Date.now(),
      input.snapshotId
    )
  const verified = selectSnapshotRecord(database, input.snapshotId)
  if (verified === undefined) throw new Error("verified user index snapshot was not readable")
  return verified
}

const fail = (database: DatabaseSync, input: FailUserIndexSnapshot): UserIndexSnapshotRecord => {
  const record = selectSnapshotRecord(database, input.snapshotId)
  if (record === undefined) throw new UserIndexSnapshotNotFound({ snapshotId: input.snapshotId })
  if (input.code.trim().length === 0) {
    throw new InvalidSnapshotUpdate({
      snapshotId: input.snapshotId,
      field: "failureCode",
      reason: "must not be empty"
    })
  }
  if (record.state === "FAILED") {
    if (record.failureCode === input.code) return record
    throw new InvalidSnapshotTransition({
      snapshotId: input.snapshotId,
      current: record.state,
      requested: "FAILED"
    })
  }
  if (record.state !== "BUILDING") {
    throw new InvalidSnapshotTransition({
      snapshotId: input.snapshotId,
      current: record.state,
      requested: "FAILED"
    })
  }
  database
    .prepare(
      `UPDATE user_index_snapshots SET state = 'FAILED', failure_code = ?, updated_at_ms = ?
        WHERE snapshot_id = ?`
    )
    .run(input.code, Date.now(), input.snapshotId)
  const failed = selectSnapshotRecord(database, input.snapshotId)
  if (failed === undefined) throw new Error("failed user index snapshot was not readable")
  return failed
}

const selectPointer = (database: DatabaseSync, scope: UserIndexSnapshotScope): DatabaseRow | undefined =>
  database
    .prepare(
      `SELECT snapshot_id, manifest_version, activated_at_ms FROM active_index_snapshots
        WHERE tenant = ? AND uid = ?`
    )
    .get(scope.tenant, scope.uid)

/** Keep legacy companion pointers aligned with the snapshot authority in the same SQLite transaction. */
const activateSnapshotBindings = (
  database: DatabaseSync,
  record: UserIndexSnapshotRecord,
  activatedAtMs: number
): void => {
  const { snapshot } = record
  database
    .prepare(
      `INSERT INTO active_index_generations (tenant, uid, generation_id, activated_at_ms)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(tenant,uid) DO UPDATE SET
         generation_id = excluded.generation_id,
         activated_at_ms = excluded.activated_at_ms`
    )
    .run(snapshot.scope.tenantId, snapshot.scope.uid, snapshot.indexGenerationId, activatedAtMs)
  database
    .prepare(
      `INSERT INTO active_entity_canonical_views (tenant, uid, view_id, activated_at_ms)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(tenant,uid) DO UPDATE SET
         view_id = excluded.view_id,
         activated_at_ms = excluded.activated_at_ms`
    )
    .run(snapshot.scope.tenantId, snapshot.scope.uid, snapshot.canonicalViewId, activatedAtMs)
}

const activate = (database: DatabaseSync, input: ActivateIndexSnapshot): ActiveIndexSnapshot => {
  const scope = scopeFor(input)
  if (!Number.isSafeInteger(input.expectedManifestVersion) || input.expectedManifestVersion < 0) {
    throw new InvalidSnapshotUpdate({
      snapshotId: input.snapshotId,
      field: "expectedManifestVersion",
      reason: "must be a non-negative safe integer"
    })
  }
  if (
    input.expectedActiveSnapshotId !== null &&
    input.expectedActiveSnapshotId.trim().length === 0
  ) {
    throw new InvalidSnapshotUpdate({
      snapshotId: input.snapshotId,
      field: "expectedActiveSnapshotId",
      reason: "must be null or a non-empty snapshot id"
    })
  }
  const record = selectSnapshotRecord(database, input.snapshotId)
  if (record === undefined) throw new UserIndexSnapshotNotFound({ snapshotId: input.snapshotId })
  if (
    record.snapshot.scope.tenantId !== scope.tenantId ||
    record.snapshot.scope.uid !== scope.uid
  ) {
    throw new SnapshotScopeMismatch({
      snapshotId: input.snapshotId,
      tenant: input.tenant,
      uid: input.uid
    })
  }
  const pointer = selectPointer(database, input)
  if (pointer !== undefined && text(pointer, "snapshot_id") === input.snapshotId) {
    if (record.state !== "ACTIVE") {
      throw new Error("active snapshot pointer named a snapshot that was not ACTIVE")
    }
    const activatedAtMs = integer(pointer, "activated_at_ms")
    activateSnapshotBindings(database, record, activatedAtMs)
    return {
      record,
      manifestVersion: integer(pointer, "manifest_version"),
      activatedAtMs
    }
  }
  if (record.state !== "VERIFIED" && record.state !== "SUPERSEDED") {
    throw new InvalidSnapshotTransition({
      snapshotId: input.snapshotId,
      current: record.state,
      requested: "ACTIVE"
    })
  }
  const listed = new Set(record.snapshot.sourceCommitIds)
  for (const commitId of listed) {
    const revision = selectRevisionByCommitId(database, commitId)
    if (revision === undefined) {
      throw new Error(`snapshot ${input.snapshotId} listed a missing revision ${commitId}`)
    }
    if (revision.state !== "COMMITTED") {
      throw new SnapshotRevisionNotCommitted({
        snapshotId: input.snapshotId,
        commitId,
        state: revision.state
      })
    }
  }
  const committedRows = database
    .prepare(`SELECT commit_id FROM source_revisions WHERE tenant = ? AND uid = ? AND state = 'COMMITTED'`)
    .all(input.tenant, input.uid)
  const uncovered = committedRows
    .map((row) => text(row, "commit_id"))
    .filter((commitId) => !listed.has(commitId))
    .sort((left, right) => left.localeCompare(right))
  if (uncovered.length > 0) {
    throw new SnapshotRevisionCoverageMismatch({
      snapshotId: input.snapshotId,
      missingCommitIds: uncovered
    })
  }
  const manifest = database
    .prepare(`SELECT manifest_version FROM user_manifests WHERE tenant = ? AND uid = ?`)
    .get(input.tenant, input.uid)
  const actualManifestVersion = manifest === undefined ? 0 : integer(manifest, "manifest_version")
  if (actualManifestVersion !== input.expectedManifestVersion) {
    throw new SnapshotActivationConflict({
      tenant: input.tenant,
      uid: input.uid,
      snapshotId: input.snapshotId,
      expectedManifestVersion: input.expectedManifestVersion,
      actualManifestVersion
    })
  }
  const actualActiveSnapshotId =
    pointer === undefined ? null : text(pointer, "snapshot_id")
  if (actualActiveSnapshotId !== input.expectedActiveSnapshotId) {
    throw new SnapshotActivePointerConflict({
      tenant: input.tenant,
      uid: input.uid,
      snapshotId: input.snapshotId,
      expectedActiveSnapshotId: input.expectedActiveSnapshotId,
      actualActiveSnapshotId
    })
  }
  const now = Date.now()
  if (pointer !== undefined) {
    const previousId = text(pointer, "snapshot_id")
    const previous = selectSnapshotRecord(database, previousId)
    if (previous === undefined || previous.state !== "ACTIVE") {
      throw new Error("active snapshot pointer named a snapshot that was not ACTIVE")
    }
    database
      .prepare(`UPDATE user_index_snapshots SET state = 'SUPERSEDED', updated_at_ms = ? WHERE snapshot_id = ?`)
      .run(now, previousId)
  }
  database
    .prepare(`UPDATE user_index_snapshots SET state = 'ACTIVE', updated_at_ms = ? WHERE snapshot_id = ?`)
    .run(now, input.snapshotId)
  database
    .prepare(
      `INSERT INTO active_index_snapshots (tenant, uid, snapshot_id, manifest_version, activated_at_ms)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(tenant, uid) DO UPDATE SET
         snapshot_id = excluded.snapshot_id,
         manifest_version = excluded.manifest_version,
         activated_at_ms = excluded.activated_at_ms`
    )
    .run(input.tenant, input.uid, input.snapshotId, actualManifestVersion, now)
  activateSnapshotBindings(database, record, now)
  const activated = selectSnapshotRecord(database, input.snapshotId)
  if (activated === undefined) throw new Error("activated user index snapshot was not readable")
  return { record: activated, manifestVersion: actualManifestVersion, activatedAtMs: now }
}

const commitListedRevision = (
  database: DatabaseSync,
  revision: { readonly commitId: string; readonly tenant: string; readonly uid: string }
): void => {
  database
    .prepare(`UPDATE user_manifests SET manifest_version = manifest_version + 1 WHERE tenant = ? AND uid = ?`)
    .run(revision.tenant, revision.uid)
  const manifest = database
    .prepare(`SELECT manifest_version FROM user_manifests WHERE tenant = ? AND uid = ?`)
    .get(revision.tenant, revision.uid)
  if (manifest === undefined) throw new Error("manifest disappeared while committing")
  database
    .prepare(
      `UPDATE source_revisions
          SET state = 'COMMITTED', manifest_version = ?, failure_code = NULL, failure_retryable = NULL,
              updated_at_ms = ?
        WHERE commit_id = ?`
    )
    .run(integer(manifest, "manifest_version"), Date.now(), revision.commitId)
}

const commitAndActivate = (
  database: DatabaseSync,
  input: CommitAndActivateIndexSnapshot
): ActiveIndexSnapshot => {
  const scope = scopeFor(input)
  if (!Number.isSafeInteger(input.expectedManifestVersion) || input.expectedManifestVersion < 0) {
    throw new InvalidSnapshotUpdate({
      snapshotId: input.snapshotId,
      field: "expectedManifestVersion",
      reason: "must be a non-negative safe integer"
    })
  }
  if (
    input.expectedActiveSnapshotId !== null &&
    input.expectedActiveSnapshotId.trim().length === 0
  ) {
    throw new InvalidSnapshotUpdate({
      snapshotId: input.snapshotId,
      field: "expectedActiveSnapshotId",
      reason: "must be null or a non-empty snapshot id"
    })
  }
  const record = selectSnapshotRecord(database, input.snapshotId)
  if (record === undefined) throw new UserIndexSnapshotNotFound({ snapshotId: input.snapshotId })
  if (
    record.snapshot.scope.tenantId !== scope.tenantId ||
    record.snapshot.scope.uid !== scope.uid
  ) {
    throw new SnapshotScopeMismatch({
      snapshotId: input.snapshotId,
      tenant: input.tenant,
      uid: input.uid
    })
  }
  const pointer = selectPointer(database, input)
  if (pointer !== undefined && text(pointer, "snapshot_id") === input.snapshotId) {
    if (record.state !== "ACTIVE") {
      throw new Error("active snapshot pointer named a snapshot that was not ACTIVE")
    }
    const activatedAtMs = integer(pointer, "activated_at_ms")
    activateSnapshotBindings(database, record, activatedAtMs)
    return {
      record,
      manifestVersion: integer(pointer, "manifest_version"),
      activatedAtMs
    }
  }
  if (record.state !== "VERIFIED") {
    throw new InvalidSnapshotTransition({
      snapshotId: input.snapshotId,
      current: record.state,
      requested: "ACTIVE"
    })
  }
  const manifest = database
    .prepare(`SELECT manifest_version FROM user_manifests WHERE tenant = ? AND uid = ?`)
    .get(input.tenant, input.uid)
  const preCommitVersion = manifest === undefined ? 0 : integer(manifest, "manifest_version")
  if (preCommitVersion !== input.expectedManifestVersion) {
    throw new SnapshotActivationConflict({
      tenant: input.tenant,
      uid: input.uid,
      snapshotId: input.snapshotId,
      expectedManifestVersion: input.expectedManifestVersion,
      actualManifestVersion: preCommitVersion
    })
  }
  const listed = new Set(record.snapshot.sourceCommitIds)
  for (const commitId of listed) {
    const revision = selectRevisionByCommitId(database, commitId)
    if (revision === undefined) {
      throw new Error(`snapshot ${input.snapshotId} listed a missing revision ${commitId}`)
    }
    if (revision.state === "COMMITTED") continue
    if (revision.state === "CONSOLIDATED" && revision.failureRetryable !== false) {
      commitListedRevision(database, revision)
      continue
    }
    throw new SnapshotRevisionNotCommitted({
      snapshotId: input.snapshotId,
      commitId,
      state: revision.state
    })
  }
  const committedRows = database
    .prepare(`SELECT commit_id FROM source_revisions WHERE tenant = ? AND uid = ? AND state = 'COMMITTED'`)
    .all(input.tenant, input.uid)
  const uncovered = committedRows
    .map((row) => text(row, "commit_id"))
    .filter((commitId) => !listed.has(commitId))
    .sort((left, right) => left.localeCompare(right))
  if (uncovered.length > 0) {
    throw new SnapshotRevisionCoverageMismatch({
      snapshotId: input.snapshotId,
      missingCommitIds: uncovered
    })
  }
  const postCommitManifest = database
    .prepare(`SELECT manifest_version FROM user_manifests WHERE tenant = ? AND uid = ?`)
    .get(input.tenant, input.uid)
  const postCommitVersion =
    postCommitManifest === undefined ? 0 : integer(postCommitManifest, "manifest_version")
  const actualActiveSnapshotId =
    pointer === undefined ? null : text(pointer, "snapshot_id")
  if (actualActiveSnapshotId !== input.expectedActiveSnapshotId) {
    throw new SnapshotActivePointerConflict({
      tenant: input.tenant,
      uid: input.uid,
      snapshotId: input.snapshotId,
      expectedActiveSnapshotId: input.expectedActiveSnapshotId,
      actualActiveSnapshotId
    })
  }
  const now = Date.now()
  if (pointer !== undefined) {
    const previousId = text(pointer, "snapshot_id")
    const previous = selectSnapshotRecord(database, previousId)
    if (previous === undefined || previous.state !== "ACTIVE") {
      throw new Error("active snapshot pointer named a snapshot that was not ACTIVE")
    }
    database
      .prepare(`UPDATE user_index_snapshots SET state = 'SUPERSEDED', updated_at_ms = ? WHERE snapshot_id = ?`)
      .run(now, previousId)
  }
  database
    .prepare(`UPDATE user_index_snapshots SET state = 'ACTIVE', updated_at_ms = ? WHERE snapshot_id = ?`)
    .run(now, input.snapshotId)
  database
    .prepare(
      `INSERT INTO active_index_snapshots (tenant, uid, snapshot_id, manifest_version, activated_at_ms)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(tenant, uid) DO UPDATE SET
         snapshot_id = excluded.snapshot_id,
         manifest_version = excluded.manifest_version,
         activated_at_ms = excluded.activated_at_ms`
    )
    .run(input.tenant, input.uid, input.snapshotId, postCommitVersion, now)
  activateSnapshotBindings(database, record, now)
  const activated = selectSnapshotRecord(database, input.snapshotId)
  if (activated === undefined) throw new Error("activated user index snapshot was not readable")
  return { record: activated, manifestVersion: postCommitVersion, activatedAtMs: now }
}

const readActive = (
  database: DatabaseSync,
  input: UserIndexSnapshotScope
): ActiveIndexSnapshot | null => {
  scopeFor(input)
  const pointer = selectPointer(database, input)
  if (pointer === undefined) return null
  const snapshotId = text(pointer, "snapshot_id")
  const record = selectSnapshotRecord(database, snapshotId)
  if (record === undefined || record.state !== "ACTIVE") {
    throw new Error("active snapshot pointer named a snapshot that was not ACTIVE")
  }
  return {
    record,
    manifestVersion: integer(pointer, "manifest_version"),
    activatedAtMs: integer(pointer, "activated_at_ms")
  }
}

const readActiveQuerySnapshotBinding = (
  database: DatabaseSync,
  input: UserIndexSnapshotScope
): ActiveQuerySnapshotBinding => {
  const scope = scopeFor(input)
  const active = readActive(database, input)
  const revisionCounts = database
    .prepare(
      `SELECT count(*) AS total,
              count(CASE WHEN state <> 'COMMITTED' THEN 1 END) AS uncommitted
         FROM source_revisions WHERE tenant = ? AND uid = ?`
    )
    .get(scope.tenantId, scope.uid)
  const snapshotCounts = database
    .prepare(`SELECT count(*) AS total FROM user_index_snapshots WHERE tenant = ? AND uid = ?`)
    .get(scope.tenantId, scope.uid)
  const manifest = database
    .prepare(`SELECT manifest_version FROM user_manifests WHERE tenant = ? AND uid = ?`)
    .get(scope.tenantId, scope.uid)
  return {
    active,
    manifestVersion: manifest === undefined ? 0 : integer(manifest, "manifest_version"),
    scopeRevisions: revisionCounts === undefined ? 0 : integer(revisionCounts, "total"),
    uncommittedRevisions:
      revisionCounts === undefined ? 0 : integer(revisionCounts, "uncommitted"),
    snapshots: snapshotCounts === undefined ? 0 : integer(snapshotCounts, "total")
  }
}

export const createSnapshotOperations = (database: DatabaseSync): SnapshotOperations => ({
  registerUserIndexSnapshot: (input) =>
    Effect.try({
      try: () => transaction(database, () => register(database, input)),
      catch: (cause) =>
        cause instanceof InvalidUserIndexSnapshot ||
        cause instanceof IndexGenerationNotFound ||
        cause instanceof EntityCanonicalViewNotFound ||
        cause instanceof UserIndexSnapshotBindingMismatch ||
        cause instanceof UserIndexSnapshotConflict
          ? cause
          : new IngestManifestUnavailable({ operation: "registerUserIndexSnapshot", cause })
    }),

  verifyUserIndexSnapshot: (input) =>
    Effect.try({
      try: () => transaction(database, () => verify(database, input)),
      catch: (cause) =>
        cause instanceof UserIndexSnapshotNotFound ||
        cause instanceof InvalidSnapshotTransition ||
        cause instanceof InvalidSnapshotUpdate ||
        cause instanceof SnapshotVerificationConflict
          ? cause
          : new IngestManifestUnavailable({ operation: "verifyUserIndexSnapshot", cause })
    }),

  failUserIndexSnapshot: (input) =>
    Effect.try({
      try: () => transaction(database, () => fail(database, input)),
      catch: (cause) =>
        cause instanceof UserIndexSnapshotNotFound ||
        cause instanceof InvalidSnapshotTransition ||
        cause instanceof InvalidSnapshotUpdate
          ? cause
          : new IngestManifestUnavailable({ operation: "failUserIndexSnapshot", cause })
    }),

  readUserIndexSnapshot: (snapshotId) =>
    Effect.try({
      try: () => selectSnapshotRecord(database, snapshotId) ?? null,
      catch: (cause) => new IngestManifestUnavailable({ operation: "readUserIndexSnapshot", cause })
    }),

  listUserIndexSnapshots: (scope) =>
    Effect.try({
      try: () => {
        const parsed = scopeFor(scope)
        const rows = database
          .prepare(
            `SELECT ${SNAPSHOT_COLUMNS} FROM user_index_snapshots
              WHERE tenant = ? AND uid = ?
              ORDER BY created_at_ms ASC, snapshot_id ASC`
          )
          .all(parsed.tenantId, parsed.uid)
        return rows.map((row) => decodeRecord(database, row))
      },
      catch: (cause) =>
        cause instanceof InvalidMemoryScope
          ? cause
          : new IngestManifestUnavailable({ operation: "listUserIndexSnapshots", cause })
    }),

  readActiveIndexSnapshot: (scope) =>
    Effect.try({
      try: () => readActive(database, scope),
      catch: (cause) =>
        cause instanceof InvalidMemoryScope
          ? cause
          : new IngestManifestUnavailable({ operation: "readActiveIndexSnapshot", cause })
    }),

  readActiveQuerySnapshotBinding: (scope) =>
    Effect.try({
      try: () => readTransaction(database, () => readActiveQuerySnapshotBinding(database, scope)),
      catch: (cause) =>
        cause instanceof InvalidMemoryScope
          ? cause
          : new IngestManifestUnavailable({ operation: "readActiveQuerySnapshotBinding", cause })
    }),

  activateIndexSnapshot: (input) =>
    Effect.try({
      try: () => transaction(database, () => activate(database, input)),
      catch: (cause) =>
        cause instanceof InvalidMemoryScope ||
        cause instanceof InvalidSnapshotUpdate ||
        cause instanceof UserIndexSnapshotNotFound ||
        cause instanceof SnapshotScopeMismatch ||
        cause instanceof InvalidSnapshotTransition ||
        cause instanceof SnapshotRevisionNotCommitted ||
        cause instanceof SnapshotRevisionCoverageMismatch ||
        cause instanceof SnapshotActivePointerConflict ||
        cause instanceof SnapshotActivationConflict
          ? cause
          : new IngestManifestUnavailable({ operation: "activateIndexSnapshot", cause })
    }),

  commitAndActivateIndexSnapshot: (input) =>
    Effect.try({
      try: () => transaction(database, () => commitAndActivate(database, input)),
      catch: (cause) =>
        cause instanceof InvalidMemoryScope ||
        cause instanceof InvalidSnapshotUpdate ||
        cause instanceof UserIndexSnapshotNotFound ||
        cause instanceof SnapshotScopeMismatch ||
        cause instanceof InvalidSnapshotTransition ||
        cause instanceof SnapshotRevisionNotCommitted ||
        cause instanceof SnapshotRevisionCoverageMismatch ||
        cause instanceof SnapshotActivePointerConflict ||
        cause instanceof SnapshotActivationConflict
          ? cause
          : new IngestManifestUnavailable({ operation: "commitAndActivateIndexSnapshot", cause })
    })
})
