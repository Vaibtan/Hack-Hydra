import { createHash } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import { Effect } from "effect"
import { parseMemoryScope, type MemoryScope } from "../MemoryScope.js"
import { parseExtractionGeneration } from "../SourceIdentity.js"
import { integer, revisionKey, selectRevision, selectRevisionByCommitId, text, transaction } from "./Rows.js"
import {
  IngestManifestUnavailable,
  IngestRevisionBlocked,
  InvalidIngestTransition,
  InvalidSourceRevision,
  type AdvanceIngestState,
  type BeginSourceRevision,
  type BeginSourceRevisionResult,
  type ExtractionGenerationReference,
  type IngestManifestError,
  type IngestState,
  type RecordIngestFailure,
  type SourceRevision,
  type SourceRevisionIdentity
} from "./Types.js"

export interface RevisionOperations {
  readonly begin: (
    input: BeginSourceRevision
  ) => Effect.Effect<BeginSourceRevisionResult, IngestManifestError>
  readonly advance: (
    input: AdvanceIngestState
  ) => Effect.Effect<
    SourceRevision,
    InvalidIngestTransition | IngestRevisionBlocked | IngestManifestUnavailable
  >
  readonly recordFailure: (
    input: RecordIngestFailure
  ) => Effect.Effect<SourceRevision, InvalidSourceRevision | IngestManifestUnavailable>
  readonly read: (
    input: SourceRevisionIdentity
  ) => Effect.Effect<SourceRevision | null, InvalidSourceRevision | IngestManifestUnavailable>
  /** Resolve one revision by its content-addressed commit id; the snapshot build follows manifest-listed ids. */
  readonly readSourceRevisionByCommitId: (
    commitId: string
  ) => Effect.Effect<SourceRevision | null, IngestManifestUnavailable>
  readonly readExtractionGeneration: (
    id: string
  ) => Effect.Effect<ExtractionGenerationReference | null, InvalidSourceRevision | IngestManifestUnavailable>
}

const NEXT_STATE: Readonly<Record<IngestState, IngestState | null>> = {
  RECEIVED: "SOURCE_DURABLE",
  SOURCE_DURABLE: "INDEXED",
  INDEXED: "ENRICHED",
  ENRICHED: "CONSOLIDATED",
  CONSOLIDATED: "COMMITTED",
  COMMITTED: null
}

const commitIdFor = (key: string): string =>
  `ingest-${createHash("sha256").update(key, "utf8").digest("hex")}`

const invalid = (
  field: keyof BeginSourceRevision,
  reason: string
): Effect.Effect<never, InvalidSourceRevision> => Effect.fail(new InvalidSourceRevision({ field, reason }))

const scopeFor = (input: { readonly tenant: string; readonly uid: string }): MemoryScope => {
  const parsed = parseMemoryScope(input.tenant, input.uid)
  if (parsed._tag === "Failure") {
    throw new InvalidSourceRevision({
      field: parsed.failure.field === "tenantId" ? "tenant" : "uid",
      reason: parsed.failure.reason
    })
  }
  return parsed.success
}

const revisionKeyFor = (input: SourceRevisionIdentity): string => revisionKey(scopeFor(input), input)

const parseBegin = (
  input: BeginSourceRevision
): Effect.Effect<BeginSourceRevision, InvalidSourceRevision> =>
  Effect.gen(function* () {
    for (const field of ["tenant", "uid", "logicalSessionId"] as const) {
      if (input[field].trim().length === 0) {
        return yield* invalid(field, "must not be empty")
      }
    }
    if (input.extractionGeneration.id.trim().length === 0) {
      return yield* invalid("extractionGeneration", "id must not be empty")
    }
    if (input.extractionGeneration.canonicalJson.trim().length === 0) {
      return yield* invalid("extractionGeneration", "canonical definition must not be empty")
    }
    const generation = parseExtractionGeneration(
      input.extractionGeneration.id,
      input.extractionGeneration.canonicalJson
    )
    if (generation._tag === "Failure") {
      return yield* invalid(
        "extractionGeneration",
        generation.failure.reason === "identifierMismatch"
          ? "id must match its canonical definition"
          : "definition must be a valid canonical extraction generation"
      )
    }
    if (!/^[a-f0-9]{64}$/.test(input.sourceDigest)) {
      return yield* invalid("sourceDigest", "must be a lowercase SHA-256 hex digest")
    }
    if (!Number.isSafeInteger(input.sourceBytes) || input.sourceBytes < 0) {
      return yield* invalid("sourceBytes", "must be a non-negative safe integer")
    }
    return input
  })

export const selectExtractionGeneration = (
  database: DatabaseSync,
  id: string
): ExtractionGenerationReference | undefined => {
  const row = database
    .prepare("SELECT id, canonical_json FROM extraction_generations WHERE id = ?")
    .get(id)
  if (row === undefined) return undefined
  return { id: text(row, "id"), canonicalJson: text(row, "canonical_json") }
}

const ensureExtractionGeneration = (
  database: DatabaseSync,
  generation: ExtractionGenerationReference
): void => {
  database
    .prepare(
      `INSERT INTO extraction_generations (id, canonical_json, created_at_ms)
       VALUES (?, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    )
    .run(generation.id, generation.canonicalJson, Date.now())
  const recorded = selectExtractionGeneration(database, generation.id)
  if (recorded === undefined) throw new Error("inserted extraction generation was not readable")
  if (recorded.canonicalJson !== generation.canonicalJson) {
    throw new InvalidSourceRevision({
      field: "extractionGeneration",
      reason: "id already names a different canonical definition"
    })
  }
}

const allocateSessionOrdinal = (database: DatabaseSync, parsed: BeginSourceRevision): number => {
  const ordinalRow = database
    .prepare(
      `SELECT session_ordinal
         FROM source_revisions
        WHERE tenant = ? AND uid = ? AND logical_session_id = ?
        ORDER BY created_at_ms ASC
        LIMIT 1`
    )
    .get(parsed.tenant, parsed.uid, parsed.logicalSessionId)
  if (ordinalRow !== undefined) return integer(ordinalRow, "session_ordinal")

  const manifest = database
    .prepare(`SELECT next_session_ordinal, manifest_version FROM user_manifests WHERE tenant = ? AND uid = ?`)
    .get(parsed.tenant, parsed.uid)
  if (manifest === undefined) {
    database
      .prepare(
        `INSERT INTO user_manifests (tenant, uid, next_session_ordinal, manifest_version)
         VALUES (?, ?, ?, ?)`
      )
      .run(parsed.tenant, parsed.uid, 2, 0)
    return 1
  }
  const next = integer(manifest, "next_session_ordinal")
  database
    .prepare(`UPDATE user_manifests SET next_session_ordinal = ? WHERE tenant = ? AND uid = ?`)
    .run(next + 1, parsed.tenant, parsed.uid)
  return next
}

const insertRevision = (database: DatabaseSync, parsed: BeginSourceRevision): BeginSourceRevisionResult => {
  ensureExtractionGeneration(database, parsed.extractionGeneration)
  const identity: SourceRevisionIdentity = {
    tenant: parsed.tenant,
    uid: parsed.uid,
    logicalSessionId: parsed.logicalSessionId,
    sourceDigest: parsed.sourceDigest,
    extractionGeneration: parsed.extractionGeneration.id
  }
  const key = revisionKeyFor(identity)
  const existing = selectRevision(database, key)
  if (existing !== undefined) {
    return { disposition: existing.state === "COMMITTED" ? "committed" : "resumed", revision: existing }
  }

  const sessionOrdinal = allocateSessionOrdinal(database, parsed)
  const manifestRow = database
    .prepare(`SELECT manifest_version FROM user_manifests WHERE tenant = ? AND uid = ?`)
    .get(parsed.tenant, parsed.uid)
  if (manifestRow === undefined) throw new Error("manifest disappeared during transaction")
  const manifestVersion = integer(manifestRow, "manifest_version")
  const now = Date.now()
  database
    .prepare(
      `INSERT INTO source_revisions (
        revision_key, tenant, uid, logical_session_id, source_digest, source_bytes,
        extraction_generation, session_ordinal, commit_id, state, manifest_version,
        created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'RECEIVED', ?, ?, ?)`
    )
    .run(
      key,
      parsed.tenant,
      parsed.uid,
      parsed.logicalSessionId,
      parsed.sourceDigest,
      parsed.sourceBytes,
      identity.extractionGeneration,
      sessionOrdinal,
      commitIdFor(key),
      manifestVersion,
      now,
      now
    )
  const created = selectRevision(database, key)
  if (created === undefined) throw new Error("inserted source revision was not readable")
  return { disposition: "created", revision: created }
}

type AdvanceOutcome =
  | { readonly _tag: "success"; readonly revision: SourceRevision }
  | { readonly _tag: "invalid"; readonly current: IngestState }

const advanceRevision = (database: DatabaseSync, input: AdvanceIngestState): AdvanceOutcome => {
  const key = revisionKeyFor(input.revision)
  const current = selectRevision(database, key)
  if (current === undefined) return { _tag: "invalid", current: input.revision.state }
  if (current.failureRetryable === false && current.failureCode !== null) {
    throw new IngestRevisionBlocked({
      commitId: current.commitId,
      state: current.state,
      failureCode: current.failureCode
    })
  }
  if (current.state === input.to) return { _tag: "success", revision: current }
  if (current.state !== input.from || NEXT_STATE[input.from] !== input.to) {
    return { _tag: "invalid", current: current.state }
  }

  const now = Date.now()
  let manifestVersion = current.manifestVersion
  if (input.to === "COMMITTED") {
    database
      .prepare(`UPDATE user_manifests SET manifest_version = manifest_version + 1 WHERE tenant = ? AND uid = ?`)
      .run(current.tenant, current.uid)
    const manifest = database
      .prepare(`SELECT manifest_version FROM user_manifests WHERE tenant = ? AND uid = ?`)
      .get(current.tenant, current.uid)
    if (manifest === undefined) throw new Error("manifest disappeared while committing")
    manifestVersion = integer(manifest, "manifest_version")
  }
  database
    .prepare(
      `UPDATE source_revisions
          SET state = ?, manifest_version = ?, failure_code = NULL, failure_retryable = NULL,
              updated_at_ms = ?
        WHERE revision_key = ?`
    )
    .run(input.to, manifestVersion, now, key)
  const advanced = selectRevision(database, key)
  if (advanced === undefined) throw new Error("advanced source revision was not readable")
  return { _tag: "success", revision: advanced }
}

const recordRevisionFailure = (database: DatabaseSync, input: RecordIngestFailure): SourceRevision => {
  const key = revisionKeyFor(input.revision)
  const current = selectRevision(database, key)
  if (current === undefined) {
    throw new InvalidSourceRevision({ field: "sourceDigest", reason: "does not name a stored source revision" })
  }
  if (current.state === "COMMITTED") {
    throw new InvalidSourceRevision({
      field: "sourceDigest",
      reason: "cannot record a failure for a committed source revision"
    })
  }
  database
    .prepare(
      `UPDATE source_revisions
          SET failure_code = ?, failure_retryable = ?, updated_at_ms = ?
        WHERE revision_key = ?`
    )
    .run(input.code, input.retryable ? 1 : 0, Date.now(), key)
  const failed = selectRevision(database, key)
  if (failed === undefined) throw new Error("failed source revision was not readable")
  return failed
}

export const createRevisionOperations = (database: DatabaseSync): RevisionOperations => ({
  begin: (input) =>
    parseBegin(input).pipe(
      Effect.flatMap((parsed) =>
        Effect.try({
          try: () => transaction(database, () => insertRevision(database, parsed)),
          catch: (cause) =>
            cause instanceof InvalidSourceRevision
              ? cause
              : new IngestManifestUnavailable({ operation: "begin", cause })
        })
      )
    ),

  advance: (input) =>
    Effect.try({
      try: () => {
        const result = transaction(database, () => advanceRevision(database, input))
        if (result._tag === "invalid") {
          throw new InvalidIngestTransition({
            commitId: input.revision.commitId,
            current: result.current,
            requestedFrom: input.from,
            requestedTo: input.to
          })
        }
        return result.revision
      },
      catch: (cause) =>
        cause instanceof InvalidIngestTransition || cause instanceof IngestRevisionBlocked
          ? cause
          : new IngestManifestUnavailable({ operation: "advance", cause })
    }),

  recordFailure: (input) =>
    Effect.try({
      try: () => {
        if (input.code.trim().length === 0) {
          throw new InvalidSourceRevision({ field: "logicalSessionId", reason: "failure code must not be empty" })
        }
        return transaction(database, () => recordRevisionFailure(database, input))
      },
      catch: (cause) =>
        cause instanceof InvalidSourceRevision
          ? cause
          : new IngestManifestUnavailable({ operation: "recordFailure", cause })
    }),

  read: (input) =>
    Effect.try({
      try: () => selectRevision(database, revisionKeyFor(input)) ?? null,
      catch: (cause) =>
        cause instanceof InvalidSourceRevision
          ? cause
          : new IngestManifestUnavailable({ operation: "read", cause })
    }),

  readSourceRevisionByCommitId: (commitId) =>
    Effect.try({
      try: () => selectRevisionByCommitId(database, commitId) ?? null,
      catch: (cause) => new IngestManifestUnavailable({ operation: "readSourceRevisionByCommitId", cause })
    }),

  readExtractionGeneration: (id) =>
    Effect.try({
      try: () => {
        if (id.trim().length === 0) {
          throw new InvalidSourceRevision({ field: "extractionGeneration", reason: "id must not be empty" })
        }
        return selectExtractionGeneration(database, id) ?? null
      },
      catch: (cause) =>
        cause instanceof InvalidSourceRevision
          ? cause
          : new IngestManifestUnavailable({ operation: "readGeneration", cause })
    })
})
