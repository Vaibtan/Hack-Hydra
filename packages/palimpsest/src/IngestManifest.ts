import { createHash } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { Config, Context, Data, Effect, Layer } from "effect"
import {
  parseEntityCanonicalView,
  serializeEntityCanonicalView,
  type EntityCanonicalView
} from "./EntityCanonicalView.js"
import {
  InvalidExtractionArtifact,
  parseExtractionArtifact,
  type ExtractionArtifact
} from "./ExtractionArtifact.js"
import {
  InvalidIndexGeneration,
  parseIndexGeneration,
  type IndexGeneration
} from "./IndexGeneration.js"
import { canonicalJson, parseExtractionGeneration } from "./SourceIdentity.js"
import { EMPTY_STATS, type UserStats } from "./User.js"

/** The ordered durable stages of one source revision. */
export const INGEST_STATES = [
  "RECEIVED",
  "SOURCE_DURABLE",
  "INDEXED",
  "ENRICHED",
  "CONSOLIDATED",
  "COMMITTED"
] as const

/** The durable readiness of a source revision. */
export type IngestState = (typeof INGEST_STATES)[number]

/** Auditable definition backing the extraction-generation id on a revision. */
export interface ExtractionGenerationReference {
  /** Stable identifier used by source revisions and cache namespaces. */
  readonly id: string
  /** Canonical descriptor containing extractor, model, tokenizer, prompt and schema hashes. */
  readonly canonicalJson: string
}

/** Fields sufficient to address an existing source revision. */
export interface SourceRevisionIdentity {
  readonly tenant: string
  readonly uid: string
  readonly logicalSessionId: string
  readonly sourceDigest: string
  readonly extractionGeneration: string
}

/** Immutable input that identifies one source revision. */
export interface BeginSourceRevision {
  /** Tenant that owns the source. */
  readonly tenant: string
  /** User that owns the source. */
  readonly uid: string
  /** Caller-visible logical session identity. */
  readonly logicalSessionId: string
  /** SHA-256 digest of the canonical verbatim source bytes. */
  readonly sourceDigest: string
  /** UTF-8 byte length of the canonical verbatim source bytes. */
  readonly sourceBytes: number
  /** Immutable, auditable prompt/model/schema/tokenizer generation definition. */
  readonly extractionGeneration: ExtractionGenerationReference
}

/** A source revision persisted by the manifest authority. */
export interface SourceRevision {
  /** Tenant that owns the revision. */
  readonly tenant: string
  /** User that owns the revision. */
  readonly uid: string
  /** Caller-visible logical session identity. */
  readonly logicalSessionId: string
  /** SHA-256 digest of the source bytes. */
  readonly sourceDigest: string
  /** UTF-8 byte length of the source bytes. */
  readonly sourceBytes: number
  /** Extraction generation used for the derived data. */
  readonly extractionGeneration: string
  /** Per-user ordinal allocated once for the logical session. */
  readonly sessionOrdinal: number
  /** Deterministic idempotency identity for this ingest revision. */
  readonly commitId: string
  /** Current durable stage. */
  readonly state: IngestState
  /** User-manifest version recorded at allocation or successful commit. */
  readonly manifestVersion: number
  /** Safe failure classification from the most recent unsuccessful attempt. */
  readonly failureCode: string | null
  /** Whether retrying the failed stage is allowed. */
  readonly failureRetryable: boolean | null
}

/** Commit-id-keyed delta for the rebuildable materialised user projections. */
export interface ApplyProjectionDelta {
  /** Source revision whose terminal commit will make this delta active. */
  readonly revision: SourceRevision
  /** User-root totals produced by this commit only. */
  readonly stats: UserStats
  /** Per-token additions to `Token.df`, keyed by the stable token key. */
  readonly tokenDf: ReadonlyMap<string, number>
  /** Per-slot additions to `Slot.n_claims`, keyed by the stable slot key. */
  readonly slotClaims: ReadonlyMap<string, number>
}

/** Read model for the durable, rebuildable projection ledger. */
export interface ProjectionState {
  readonly tenant: string
  readonly uid: string
  /** Manifest version the projection represents, rather than a graph scan time. */
  readonly manifestVersion: number
  readonly lastCommitId: string | null
  readonly lastReconciledCommitId: string | null
  readonly stats: UserStats
  readonly consistency: "consistent" | "stale" | "unknown"
}

/** Scoped per-token and per-slot totals rebuilt from commit deltas. */
export interface ProjectionCounts {
  readonly tokenDf: ReadonlyMap<string, number>
  readonly slotClaims: ReadonlyMap<string, number>
}

/** Outcome of rebuilding one user's projection ledger. */
export interface ProjectionReconciliation {
  readonly state: ProjectionState
  readonly outcome: "consistent" | "repaired" | "unknown"
}

/** Tenant/user scope that owns a selected Entity canonical view. */
export interface EntityCanonicalViewScope {
  readonly tenant: string
  readonly uid: string
}

/** Immutable canonical view to persist under its owning user scope. */
export interface StoreEntityCanonicalView extends EntityCanonicalViewScope {
  readonly view: EntityCanonicalView
}

/** Request to atomically select a previously stored Entity canonical view. */
export interface ActivateEntityCanonicalView extends EntityCanonicalViewScope {
  readonly viewId: string
}

/** Tenant/user scope that selects one query-visible derived index generation. */
export interface IndexGenerationScope {
  readonly tenant: string
  readonly uid: string
}

/** Immutable index generation to persist before it can be activated. */
export interface StoreIndexGeneration {
  readonly generation: IndexGeneration
}

/** Request to atomically select one previously stored index generation. */
export interface ActivateIndexGeneration extends IndexGenerationScope {
  readonly generationId: string
}

/** Immutable model output to persist against one source-processing revision. */
export interface StoreExtractionArtifact {
  readonly revision: SourceRevision
  readonly artifact: ExtractionArtifact
}

/** Outcome of claiming a source revision for ingest. */
export interface BeginSourceRevisionResult {
  /** Whether the revision was inserted, resumed, or was already committed. */
  readonly disposition: "created" | "resumed" | "committed"
  /** The current durable source revision. */
  readonly revision: SourceRevision
}

/** A requested state transition for a source revision. */
export interface AdvanceIngestState {
  /** The revision whose state is being advanced. */
  readonly revision: SourceRevision
  /** Expected current state. */
  readonly from: IngestState
  /** Requested next state. */
  readonly to: IngestState
}

/** A safe failure record attached to an incomplete source revision. */
export interface RecordIngestFailure {
  /** The revision whose latest attempt failed. */
  readonly revision: SourceRevision
  /** Stable error code with no raw provider or secret material. */
  readonly code: string
  /** Whether a later caller may resume the failed stage. */
  readonly retryable: boolean
}

/** Input could not name a valid source revision. */
export class InvalidSourceRevision extends Data.TaggedError("InvalidSourceRevision")<{
  readonly field: keyof BeginSourceRevision
  readonly reason: string
}> {
  override get message(): string {
    return `Invalid source revision ${this.field}: ${this.reason}`
  }
}

/** A caller attempted to skip or rewind a durable ingest stage. */
export class InvalidIngestTransition extends Data.TaggedError("InvalidIngestTransition")<{
  readonly commitId: string
  readonly current: IngestState
  readonly requestedFrom: IngestState
  readonly requestedTo: IngestState
}> {
  override get message(): string {
    return `Cannot advance ${this.commitId} from ${this.current} as ${this.requestedFrom} -> ${this.requestedTo}`
  }
}

/** A terminal stage failure prevents an incomplete revision from being advanced. */
export class IngestRevisionBlocked extends Data.TaggedError("IngestRevisionBlocked")<{
  readonly commitId: string
  readonly state: IngestState
  readonly failureCode: string
}> {
  override get message(): string {
    return `Source revision ${this.commitId} is blocked at ${this.state} by ${this.failureCode}`
  }
}

/** A projection delta was malformed or could not name an eligible revision. */
export class InvalidProjectionDelta extends Data.TaggedError("InvalidProjectionDelta")<{
  readonly field: "stats" | "tokenDf" | "slotClaims" | "revision"
  readonly reason: string
}> {
  override get message(): string {
    return `Invalid projection delta ${this.field}: ${this.reason}`
  }
}

/** One commit id was reused with different projection bytes. */
export class ProjectionDeltaConflict extends Data.TaggedError("ProjectionDeltaConflict")<{
  readonly commitId: string
}> {
  override get message(): string {
    return `Projection delta for ${this.commitId} conflicts with its recorded bytes`
  }
}

/** A new delta would skip or replay a user manifest version. */
export class ProjectionVersionConflict extends Data.TaggedError("ProjectionVersionConflict")<{
  readonly tenant: string
  readonly uid: string
  readonly expectedPreviousVersion: number
  readonly actualVersion: number
}> {
  override get message(): string {
    return `Projection for ${this.tenant}/${this.uid} expected version ${this.expectedPreviousVersion}, found ${this.actualVersion}`
  }
}

/** A canonical view id was already bound to different immutable view bytes. */
export class EntityCanonicalViewConflict extends Data.TaggedError("EntityCanonicalViewConflict")<{
  readonly tenant: string
  readonly uid: string
  readonly viewId: string
}> {
  override get message(): string {
    return `Entity canonical view ${this.viewId} conflicts for ${this.tenant}/${this.uid}`
  }
}

/** A requested active Entity canonical view was never stored for this user. */
export class EntityCanonicalViewNotFound extends Data.TaggedError("EntityCanonicalViewNotFound")<{
  readonly tenant: string
  readonly uid: string
  readonly viewId: string
}> {
  override get message(): string {
    return `Entity canonical view ${this.viewId} was not found for ${this.tenant}/${this.uid}`
  }
}

/** An index-generation id was already bound to different immutable bytes. */
export class IndexGenerationConflict extends Data.TaggedError("IndexGenerationConflict")<{
  readonly generationId: string
}> {
  override get message(): string {
    return `Index generation ${this.generationId} conflicts with its recorded definition`
  }
}

/** An index generation cannot be stored unless its extraction definition exists. */
export class IndexGenerationExtractionNotFound extends Data.TaggedError(
  "IndexGenerationExtractionNotFound"
)<{
  readonly extractionGenerationId: string
}> {
  override get message(): string {
    return `Index generation references unknown extraction generation ${this.extractionGenerationId}`
  }
}

/** A requested active index generation was never stored. */
export class IndexGenerationNotFound extends Data.TaggedError("IndexGenerationNotFound")<{
  readonly generationId: string
}> {
  override get message(): string {
    return `Index generation ${this.generationId} was not found`
  }
}

/** One source-processing revision was bound to non-matching extraction output. */
export class ExtractionArtifactBindingMismatch extends Data.TaggedError(
  "ExtractionArtifactBindingMismatch"
)<{
  readonly commitId: string
  readonly reason: "unknownRevision" | "sourceDigest" | "extractionGeneration"
}> {
  override get message(): string {
    return `Extraction artifact ${this.commitId} has a ${this.reason} binding mismatch`
  }
}

/** A source revision must have durable source bytes before it can hold extraction output. */
export class ExtractionArtifactStateInvalid extends Data.TaggedError("ExtractionArtifactStateInvalid")<{
  readonly commitId: string
  readonly state: IngestState
}> {
  override get message(): string {
    return `Source revision ${this.commitId} cannot store extraction output at ${this.state}`
  }
}

/** One source-processing commit was offered different durable extraction bytes. */
export class ExtractionArtifactConflict extends Data.TaggedError("ExtractionArtifactConflict")<{
  readonly commitId: string
}> {
  override get message(): string {
    return `Extraction artifact for ${this.commitId} conflicts with its recorded bytes`
  }
}

/** The transactional manifest store could not complete an operation. */
export class IngestManifestUnavailable extends Data.TaggedError("IngestManifestUnavailable")<{
  readonly operation:
    | "open"
    | "begin"
    | "advance"
    | "recordFailure"
    | "read"
    | "readGeneration"
    | "applyProjectionDelta"
    | "readProjection"
    | "readProjectionCounts"
    | "reconcileProjection"
    | "storeEntityCanonicalView"
    | "activateEntityCanonicalView"
    | "readActiveEntityCanonicalView"
    | "storeIndexGeneration"
    | "activateIndexGeneration"
    | "readActiveIndexGeneration"
    | "storeExtractionArtifact"
    | "readExtractionArtifact"
  readonly cause: unknown
}> {
  override get message(): string {
    return `Ingest manifest is unavailable during ${this.operation}`
  }
}

/** All expected failures returned by the ingest manifest authority. */
export type IngestManifestError =
  | InvalidSourceRevision
  | InvalidIngestTransition
  | IngestRevisionBlocked
  | InvalidProjectionDelta
  | ProjectionDeltaConflict
  | ProjectionVersionConflict
  | EntityCanonicalViewConflict
  | EntityCanonicalViewNotFound
  | IndexGenerationConflict
  | IndexGenerationExtractionNotFound
  | IndexGenerationNotFound
  | InvalidIndexGeneration
  | InvalidExtractionArtifact
  | ExtractionArtifactBindingMismatch
  | ExtractionArtifactStateInvalid
  | ExtractionArtifactConflict
  | IngestManifestUnavailable

type DatabaseRow = Readonly<Record<string, string | number | bigint | null | Uint8Array>>

const NEXT_STATE: Readonly<Record<IngestState, IngestState | null>> = {
  RECEIVED: "SOURCE_DURABLE",
  SOURCE_DURABLE: "INDEXED",
  INDEXED: "ENRICHED",
  ENRICHED: "CONSOLIDATED",
  CONSOLIDATED: "COMMITTED",
  COMMITTED: null
}

const isIngestState = (value: unknown): value is IngestState =>
  typeof value === "string" && INGEST_STATES.some((state) => state === value)

const revisionKey = (input: SourceRevisionIdentity): string =>
  `${input.tenant}\u001f${input.uid}\u001f${input.logicalSessionId}\u001f${input.sourceDigest}\u001f${input.extractionGeneration}`

const sourceRevisionIdentity = (input: BeginSourceRevision): SourceRevisionIdentity => ({
  tenant: input.tenant,
  uid: input.uid,
  logicalSessionId: input.logicalSessionId,
  sourceDigest: input.sourceDigest,
  extractionGeneration: input.extractionGeneration.id
})

const commitIdFor = (key: string): string =>
  `ingest-${createHash("sha256").update(key, "utf8").digest("hex")}`

const invalid = (
  field: keyof BeginSourceRevision,
  reason: string
): Effect.Effect<never, InvalidSourceRevision> => Effect.fail(new InvalidSourceRevision({ field, reason }))

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
    if (generation._tag === "Left") {
      return yield* invalid(
        "extractionGeneration",
        generation.left.reason === "identifierMismatch"
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

const createDatabase = (path: string): DatabaseSync => {
  const database = new DatabaseSync(path, {
    enableForeignKeyConstraints: true,
    timeout: 5_000
  })
  database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;")
  try {
    database.exec("BEGIN IMMEDIATE")
    database.exec(`
      CREATE TABLE IF NOT EXISTS user_manifests (
        tenant TEXT NOT NULL,
        uid TEXT NOT NULL,
        next_session_ordinal INTEGER NOT NULL CHECK (next_session_ordinal >= 1),
        manifest_version INTEGER NOT NULL CHECK (manifest_version >= 0),
        PRIMARY KEY (tenant, uid)
      ) STRICT;
    `)

    const existing = database
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'source_revisions'")
      .get() as { readonly sql?: unknown } | undefined
    const oldIdentity =
      typeof existing?.sql === "string" &&
      !existing.sql.includes("UNIQUE (tenant, uid, logical_session_id, source_digest, extraction_generation)")
    if (oldIdentity) {
      // v1 omitted logical_session_id from the revision identity. Rebuild under
      // one SQLite transaction so an interrupted upgrade keeps the old table.
      database.exec("ALTER TABLE source_revisions RENAME TO source_revisions_v1")
    }

    database.exec(`
      CREATE TABLE IF NOT EXISTS extraction_generations (
        id TEXT PRIMARY KEY,
        canonical_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS source_revisions (
        revision_key TEXT PRIMARY KEY,
        tenant TEXT NOT NULL,
        uid TEXT NOT NULL,
        logical_session_id TEXT NOT NULL,
        source_digest TEXT NOT NULL,
        source_bytes INTEGER NOT NULL CHECK (source_bytes >= 0),
        extraction_generation TEXT NOT NULL,
        session_ordinal INTEGER NOT NULL CHECK (session_ordinal >= 1),
        commit_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (state IN ('RECEIVED', 'SOURCE_DURABLE', 'INDEXED', 'ENRICHED', 'CONSOLIDATED', 'COMMITTED')),
        manifest_version INTEGER NOT NULL CHECK (manifest_version >= 0),
        failure_code TEXT,
        failure_retryable INTEGER CHECK (failure_retryable IN (0, 1)),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        UNIQUE (tenant, uid, logical_session_id, source_digest, extraction_generation)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS extraction_artifacts (
        commit_id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL UNIQUE,
        canonical_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        FOREIGN KEY (commit_id) REFERENCES source_revisions (commit_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS projection_deltas (
        commit_id TEXT PRIMARY KEY,
        tenant TEXT NOT NULL,
        uid TEXT NOT NULL,
        expected_manifest_version INTEGER NOT NULL CHECK (expected_manifest_version >= 1),
        canonical_delta TEXT NOT NULL,
        applied_at_ms INTEGER NOT NULL,
        FOREIGN KEY (commit_id) REFERENCES source_revisions (commit_id),
        UNIQUE (tenant, uid, expected_manifest_version)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS user_projections (
        tenant TEXT NOT NULL,
        uid TEXT NOT NULL,
        manifest_version INTEGER NOT NULL CHECK (manifest_version >= 0),
        last_commit_id TEXT,
        last_reconciled_commit_id TEXT,
        stats_json TEXT NOT NULL,
        consistency TEXT NOT NULL CHECK (consistency IN ('consistent', 'stale', 'unknown')),
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (tenant, uid)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS projection_token_counts (
        tenant TEXT NOT NULL,
        uid TEXT NOT NULL,
        token_key TEXT NOT NULL,
        value INTEGER NOT NULL CHECK (value >= 0),
        PRIMARY KEY (tenant, uid, token_key)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS projection_slot_counts (
        tenant TEXT NOT NULL,
        uid TEXT NOT NULL,
        slot_key TEXT NOT NULL,
        value INTEGER NOT NULL CHECK (value >= 0),
        PRIMARY KEY (tenant, uid, slot_key)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS index_generations (
        generation_id TEXT PRIMARY KEY,
        extraction_generation TEXT NOT NULL,
        canonical_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        FOREIGN KEY (extraction_generation) REFERENCES extraction_generations (id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS active_index_generations (
        tenant TEXT NOT NULL,
        uid TEXT NOT NULL,
        generation_id TEXT NOT NULL,
        activated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (tenant, uid),
        FOREIGN KEY (generation_id) REFERENCES index_generations (generation_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS entity_canonical_views (
        tenant TEXT NOT NULL,
        uid TEXT NOT NULL,
        view_id TEXT NOT NULL,
        canonical_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (tenant, uid, view_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS entity_canonical_view_edges (
        tenant TEXT NOT NULL,
        uid TEXT NOT NULL,
        view_id TEXT NOT NULL,
        from_identity_id TEXT NOT NULL,
        to_canonical_identity_id TEXT NOT NULL,
        PRIMARY KEY (tenant, uid, view_id, from_identity_id),
        FOREIGN KEY (tenant, uid, view_id)
          REFERENCES entity_canonical_views (tenant, uid, view_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS active_entity_canonical_views (
        tenant TEXT NOT NULL,
        uid TEXT NOT NULL,
        view_id TEXT NOT NULL,
        activated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (tenant, uid),
        FOREIGN KEY (tenant, uid, view_id)
          REFERENCES entity_canonical_views (tenant, uid, view_id)
      ) STRICT;
    `)
    if (oldIdentity) {
      const legacyRows = database
        .prepare(`
          SELECT tenant, uid, logical_session_id, source_digest, source_bytes,
                 extraction_generation, session_ordinal, commit_id, state, manifest_version,
                 failure_code, failure_retryable, created_at_ms, updated_at_ms
            FROM source_revisions_v1
        `)
        .all() as ReadonlyArray<DatabaseRow>
      const insert = database.prepare(`
        INSERT INTO source_revisions (
          revision_key, tenant, uid, logical_session_id, source_digest, source_bytes,
          extraction_generation, session_ordinal, commit_id, state, manifest_version,
          failure_code, failure_retryable, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const row of legacyRows) {
        const identity = {
          tenant: text(row, "tenant"),
          uid: text(row, "uid"),
          logicalSessionId: text(row, "logical_session_id"),
          sourceDigest: text(row, "source_digest"),
          extractionGeneration: text(row, "extraction_generation")
        }
        const failureRetryable = nullableBoolean(row, "failure_retryable")
        insert.run(
          revisionKey(identity),
          identity.tenant,
          identity.uid,
          identity.logicalSessionId,
          identity.sourceDigest,
          integer(row, "source_bytes"),
          identity.extractionGeneration,
          integer(row, "session_ordinal"),
          text(row, "commit_id"),
          text(row, "state"),
          integer(row, "manifest_version"),
          nullableText(row, "failure_code"),
          failureRetryable === null
            ? null
            : failureRetryable
              ? 1
              : 0,
          integer(row, "created_at_ms"),
          integer(row, "updated_at_ms")
        )
      }
      database.exec("DROP TABLE source_revisions_v1")
    }
    database.exec(`
      CREATE INDEX IF NOT EXISTS source_revisions_logical_session
        ON source_revisions (tenant, uid, logical_session_id, extraction_generation, created_at_ms);
      PRAGMA user_version = 7;
      COMMIT;
    `)
  } catch (cause) {
    try {
      database.exec("ROLLBACK")
    } catch {
      // There may be no open transaction when opening the file itself failed.
    }
    database.close()
    throw cause
  }
  return database
}

const text = (row: DatabaseRow, column: string): string => {
  const value = row[column]
  if (typeof value !== "string") throw new Error(`manifest column ${column} was not text`)
  return value
}

const integer = (row: DatabaseRow, column: string): number => {
  const value = row[column]
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`manifest column ${column} was not a safe integer`)
  }
  return value
}

const nullableText = (row: DatabaseRow, column: string): string | null => {
  const value = row[column]
  if (value === null) return null
  if (typeof value !== "string") throw new Error(`manifest column ${column} was not nullable text`)
  return value
}

const nullableBoolean = (row: DatabaseRow, column: string): boolean | null => {
  const value = row[column]
  if (value === null) return null
  if (value === 0) return false
  if (value === 1) return true
  throw new Error(`manifest column ${column} was not nullable boolean`)
}

const decodeRevision = (row: DatabaseRow): SourceRevision => {
  const state = text(row, "state")
  if (!isIngestState(state)) throw new Error(`manifest state ${state} was invalid`)
  return {
    tenant: text(row, "tenant"),
    uid: text(row, "uid"),
    logicalSessionId: text(row, "logical_session_id"),
    sourceDigest: text(row, "source_digest"),
    sourceBytes: integer(row, "source_bytes"),
    extractionGeneration: text(row, "extraction_generation"),
    sessionOrdinal: integer(row, "session_ordinal"),
    commitId: text(row, "commit_id"),
    state,
    manifestVersion: integer(row, "manifest_version"),
    failureCode: nullableText(row, "failure_code"),
    failureRetryable: nullableBoolean(row, "failure_retryable")
  }
}

const selectRevision = (database: DatabaseSync, key: string): SourceRevision | undefined => {
  const row = database
    .prepare(
      `SELECT tenant, uid, logical_session_id, source_digest, source_bytes, extraction_generation,
              session_ordinal, commit_id, state, manifest_version, failure_code, failure_retryable
         FROM source_revisions
        WHERE revision_key = ?`
    )
    .get(key)
  return row === undefined ? undefined : decodeRevision(row)
}

const selectRevisionByCommitId = (database: DatabaseSync, commitId: string): SourceRevision | undefined => {
  const row = database
    .prepare(
      `SELECT tenant, uid, logical_session_id, source_digest, source_bytes, extraction_generation,
              session_ordinal, commit_id, state, manifest_version, failure_code, failure_retryable
         FROM source_revisions
        WHERE commit_id = ?`
    )
    .get(commitId)
  return row === undefined ? undefined : decodeRevision(row)
}

const selectExtractionArtifact = (
  database: DatabaseSync,
  revision: SourceRevision
): ExtractionArtifact | undefined => {
  const row = database
    .prepare(
      `SELECT artifact_id, canonical_json
         FROM extraction_artifacts
        WHERE commit_id = ?`
    )
    .get(revision.commitId) as DatabaseRow | undefined
  if (row === undefined) return undefined
  const parsed = parseExtractionArtifact(text(row, "artifact_id"), text(row, "canonical_json"))
  if (parsed._tag === "Left") throw new Error(`stored extraction artifact ${revision.commitId} was invalid`)
  if (
    parsed.right.commitId !== revision.commitId ||
    parsed.right.sourceDigest !== revision.sourceDigest ||
    parsed.right.extractionGeneration !== revision.extractionGeneration
  ) {
    throw new Error(`stored extraction artifact ${revision.commitId} had an invalid revision binding`)
  }
  return parsed.right
}

const STAT_FIELDS = [
  "claims",
  "entities",
  "slots",
  "tokens",
  "sessions",
  "turns",
  "supersessions",
  "contestedSlots"
] as const satisfies ReadonlyArray<keyof UserStats>

type ProjectionDeltaPayload = Readonly<{
  readonly canonicalJson: string
  readonly stats: UserStats
  readonly tokenDf: ReadonlyMap<string, number>
  readonly slotClaims: ReadonlyMap<string, number>
}>

const assertNonNegativeSafeInteger = (
  value: unknown,
  field: InvalidProjectionDelta["field"],
  detail: string
): number => {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 0) {
    throw new InvalidProjectionDelta({ field, reason: `${detail} must be a non-negative safe integer` })
  }
  return value
}

const validateStats = (value: unknown): UserStats => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidProjectionDelta({ field: "stats", reason: "must be an object" })
  }
  const record = value as Record<string, unknown>
  return Object.fromEntries(
    STAT_FIELDS.map((field) => [field, assertNonNegativeSafeInteger(record[field], "stats", field)])
  ) as unknown as UserStats
}

const validateCountMap = (
  value: ReadonlyMap<string, number>,
  field: "tokenDf" | "slotClaims"
): ReadonlyMap<string, number> => {
  const validated = new Map<string, number>()
  for (const [key, count] of value) {
    if (key.trim().length === 0) {
      throw new InvalidProjectionDelta({ field, reason: "keys must not be empty" })
    }
    validated.set(key, assertNonNegativeSafeInteger(count, field, `value for ${key}`))
  }
  return validated
}

const mapEntries = (entries: ReadonlyMap<string, number>): ReadonlyArray<readonly [string, number]> =>
  [...entries.entries()].sort(([left], [right]) => left.localeCompare(right))

const projectionPayload = (input: ApplyProjectionDelta): ProjectionDeltaPayload => {
  const stats = validateStats(input.stats)
  const tokenDf = validateCountMap(input.tokenDf, "tokenDf")
  const slotClaims = validateCountMap(input.slotClaims, "slotClaims")
  return {
    canonicalJson: canonicalJson({
      format: "palimpsest.projection-delta.v1",
      slot_claims: mapEntries(slotClaims),
      stats: Object.fromEntries(STAT_FIELDS.map((field) => [field, stats[field]])),
      token_df: mapEntries(tokenDf)
    }),
    stats,
    tokenDf,
    slotClaims
  }
}

const decodeProjectionPayload = (serialized: string): ProjectionDeltaPayload => {
  const parsed = JSON.parse(serialized) as {
    readonly format?: unknown
    readonly stats?: unknown
    readonly token_df?: unknown
    readonly slot_claims?: unknown
  }
  if (parsed.format !== "palimpsest.projection-delta.v1") {
    throw new Error("projection delta format was invalid")
  }
  if (!Array.isArray(parsed.token_df) || !Array.isArray(parsed.slot_claims)) {
    throw new Error("projection delta count maps were invalid")
  }
  const decodeEntries = (
    entries: ReadonlyArray<unknown>,
    field: "tokenDf" | "slotClaims"
  ): ReadonlyMap<string, number> => {
    const result = new Map<string, number>()
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") {
        throw new Error(`projection delta ${field} entry was invalid`)
      }
      result.set(entry[0], assertNonNegativeSafeInteger(entry[1], field, `value for ${entry[0]}`))
    }
    return result
  }
  const payload = {
    canonicalJson: serialized,
    stats: validateStats(parsed.stats),
    tokenDf: decodeEntries(parsed.token_df, "tokenDf"),
    slotClaims: decodeEntries(parsed.slot_claims, "slotClaims")
  }
  if (projectionPayload({ revision: {} as SourceRevision, ...payload }).canonicalJson !== serialized) {
    throw new Error("projection delta was not canonical JSON")
  }
  return payload
}

const statsJson = (stats: UserStats): string =>
  canonicalJson(Object.fromEntries(STAT_FIELDS.map((field) => [field, stats[field]])))

const decodeStatsJson = (value: string): UserStats => {
  const parsed = JSON.parse(value) as unknown
  return validateStats(parsed)
}

const addStats = (left: UserStats, right: UserStats): UserStats =>
  Object.fromEntries(STAT_FIELDS.map((field) => [field, left[field] + right[field]])) as unknown as UserStats

const sameStats = (left: UserStats, right: UserStats): boolean =>
  STAT_FIELDS.every((field) => left[field] === right[field])

const addCounts = (target: Map<string, number>, source: ReadonlyMap<string, number>): void => {
  for (const [key, value] of source) target.set(key, (target.get(key) ?? 0) + value)
}

const sameCounts = (left: ReadonlyMap<string, number>, right: ReadonlyMap<string, number>): boolean =>
  left.size === right.size && [...left].every(([key, value]) => right.get(key) === value)

const emptyProjection = (scope: IngestCommitScope): ProjectionState => ({
  tenant: scope.tenant,
  uid: scope.uid,
  manifestVersion: 0,
  lastCommitId: null,
  lastReconciledCommitId: null,
  stats: EMPTY_STATS,
  consistency: "unknown"
})

type IngestCommitScope = Readonly<{ readonly tenant: string; readonly uid: string }>

const selectProjection = (database: DatabaseSync, scope: IngestCommitScope): ProjectionState | undefined => {
  const row = database
    .prepare(
      `SELECT tenant, uid, manifest_version, last_commit_id, last_reconciled_commit_id, stats_json, consistency
         FROM user_projections
        WHERE tenant = ? AND uid = ?`
    )
    .get(scope.tenant, scope.uid)
  if (row === undefined) return undefined
  const consistency = text(row, "consistency")
  if (consistency !== "consistent" && consistency !== "stale" && consistency !== "unknown") {
    throw new Error("projection consistency was invalid")
  }
  return {
    tenant: text(row, "tenant"),
    uid: text(row, "uid"),
    manifestVersion: integer(row, "manifest_version"),
    lastCommitId: nullableText(row, "last_commit_id"),
    lastReconciledCommitId: nullableText(row, "last_reconciled_commit_id"),
    stats: decodeStatsJson(text(row, "stats_json")),
    consistency
  }
}

const selectProjectionCounts = (
  database: DatabaseSync,
  scope: IngestCommitScope
): ProjectionCounts => {
  const select = (table: "projection_token_counts" | "projection_slot_counts", key: string): ReadonlyMap<string, number> => {
    const rows = database
      .prepare(`SELECT ${key}, value FROM ${table} WHERE tenant = ? AND uid = ? ORDER BY ${key} ASC`)
      .all(scope.tenant, scope.uid) as ReadonlyArray<DatabaseRow>
    return new Map(rows.map((row) => [text(row, key), integer(row, "value")]))
  }
  return {
    tokenDf: select("projection_token_counts", "token_key"),
    slotClaims: select("projection_slot_counts", "slot_key")
  }
}

const sameStringMap = (left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): boolean =>
  left.size === right.size && [...left].every(([key, value]) => right.get(key) === value)

const selectEntityCanonicalView = (
  database: DatabaseSync,
  scope: EntityCanonicalViewScope,
  viewId: string
): EntityCanonicalView | undefined => {
  const row = database
    .prepare(
      `SELECT canonical_json
         FROM entity_canonical_views
        WHERE tenant = ? AND uid = ? AND view_id = ?`
    )
    .get(scope.tenant, scope.uid, viewId) as DatabaseRow | undefined
  if (row === undefined) return undefined
  const parsed = parseEntityCanonicalView(viewId, text(row, "canonical_json"))
  if (parsed._tag === "Left") throw new Error(`stored entity canonical view ${viewId} was invalid`)
  const rows = database
    .prepare(
      `SELECT from_identity_id, to_canonical_identity_id
         FROM entity_canonical_view_edges
        WHERE tenant = ? AND uid = ? AND view_id = ?
        ORDER BY from_identity_id ASC`
    )
    .all(scope.tenant, scope.uid, viewId) as ReadonlyArray<DatabaseRow>
  const persistedEdges = new Map(
    rows.map((edge) => [text(edge, "from_identity_id"), text(edge, "to_canonical_identity_id")])
  )
  const expectedEdges = new Map(
    parsed.right.sameAs.map((edge) => [edge.fromIdentityId, edge.toCanonicalIdentityId])
  )
  if (!sameStringMap(persistedEdges, expectedEdges)) {
    throw new Error(`stored entity canonical view edges for ${viewId} were invalid`)
  }
  return parsed.right
}

const selectExtractionGeneration = (
  database: DatabaseSync,
  id: string
): ExtractionGenerationReference | undefined => {
  const row = database
    .prepare("SELECT id, canonical_json FROM extraction_generations WHERE id = ?")
    .get(id)
  if (row === undefined) return undefined
  return { id: text(row, "id"), canonicalJson: text(row, "canonical_json") }
}

const selectIndexGeneration = (
  database: DatabaseSync,
  generationId: string
): IndexGeneration | undefined => {
  const row = database
    .prepare(
      `SELECT generation_id, extraction_generation, canonical_json
         FROM index_generations
        WHERE generation_id = ?`
    )
    .get(generationId) as DatabaseRow | undefined
  if (row === undefined) return undefined
  const parsed = parseIndexGeneration(text(row, "generation_id"), text(row, "canonical_json"))
  if (parsed._tag === "Left") throw new Error(`stored index generation ${generationId} was invalid`)
  if (parsed.right.extractionGenerationId !== text(row, "extraction_generation")) {
    throw new Error(`stored index generation ${generationId} had an inconsistent extraction reference`)
  }
  if (selectExtractionGeneration(database, parsed.right.extractionGenerationId) === undefined) {
    throw new Error(`stored index generation ${generationId} referenced a missing extraction generation`)
  }
  return parsed.right
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

const transaction = <A>(database: DatabaseSync, operation: () => A): A => {
  database.exec("BEGIN IMMEDIATE")
  try {
    const result = operation()
    database.exec("COMMIT")
    return result
  } catch (cause) {
    database.exec("ROLLBACK")
    throw cause
  }
}

const makeService = (path: string) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => createDatabase(path),
      catch: (cause) => new IngestManifestUnavailable({ operation: "open", cause })
    }),
    (database) => Effect.sync(() => database.close())
  ).pipe(
    Effect.map((database) => {
      const begin = (
        input: BeginSourceRevision
      ): Effect.Effect<BeginSourceRevisionResult, IngestManifestError> =>
        parseBegin(input).pipe(
          Effect.flatMap((parsed) =>
            Effect.try({
              try: () =>
                transaction(database, () => {
                  ensureExtractionGeneration(database, parsed.extractionGeneration)
                  const identity = sourceRevisionIdentity(parsed)
                  const key = revisionKey(identity)
                  const existing = selectRevision(database, key)
                  if (existing !== undefined) {
                    return {
                      disposition: existing.state === "COMMITTED" ? "committed" : "resumed",
                      revision: existing
                    } as const
                  }

                  const ordinalRow = database
                    .prepare(
                      `SELECT session_ordinal
                         FROM source_revisions
                        WHERE tenant = ? AND uid = ? AND logical_session_id = ?
                        ORDER BY created_at_ms ASC
                        LIMIT 1`
                    )
                    .get(parsed.tenant, parsed.uid, parsed.logicalSessionId)
                  let sessionOrdinal: number
                  if (ordinalRow === undefined) {
                    const manifest = database
                      .prepare(
                        `SELECT next_session_ordinal, manifest_version
                           FROM user_manifests
                          WHERE tenant = ? AND uid = ?`
                      )
                      .get(parsed.tenant, parsed.uid)
                    if (manifest === undefined) {
                      sessionOrdinal = 1
                      database
                        .prepare(
                          `INSERT INTO user_manifests (tenant, uid, next_session_ordinal, manifest_version)
                           VALUES (?, ?, ?, ?)`
                        )
                        .run(parsed.tenant, parsed.uid, 2, 0)
                    } else {
                      const next = integer(manifest, "next_session_ordinal")
                      sessionOrdinal = next
                      database
                        .prepare(
                          `UPDATE user_manifests
                              SET next_session_ordinal = ?
                            WHERE tenant = ? AND uid = ?`
                        )
                        .run(next + 1, parsed.tenant, parsed.uid)
                    }
                  } else {
                    sessionOrdinal = integer(ordinalRow, "session_ordinal")
                  }

                  const manifestRow = database
                    .prepare(
                      `SELECT manifest_version
                         FROM user_manifests
                        WHERE tenant = ? AND uid = ?`
                    )
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
                  return { disposition: "created", revision: created } as const
                }),
              catch: (cause) =>
                cause instanceof InvalidSourceRevision
                  ? cause
                  : new IngestManifestUnavailable({ operation: "begin", cause })
            })
          )
        )

      const advance = (
        input: AdvanceIngestState
      ): Effect.Effect<
        SourceRevision,
        InvalidIngestTransition | IngestRevisionBlocked | IngestManifestUnavailable
      > =>
        Effect.try({
          try: () => {
            const key = revisionKey(input.revision)
            const result = transaction(database, () => {
              const current = selectRevision(database, key)
              if (current === undefined) {
                return { _tag: "invalid", current: input.revision.state } as const
              }
              if (current.failureRetryable === false && current.failureCode !== null) {
                throw new IngestRevisionBlocked({
                  commitId: current.commitId,
                  state: current.state,
                  failureCode: current.failureCode
                })
              }
              if (current.state === input.to) return { _tag: "success", revision: current } as const
              if (current.state !== input.from || NEXT_STATE[input.from] !== input.to) {
                return { _tag: "invalid", current: current.state } as const
              }

              const now = Date.now()
              let manifestVersion = current.manifestVersion
              if (input.to === "COMMITTED") {
                database
                  .prepare(
                    `UPDATE user_manifests
                        SET manifest_version = manifest_version + 1
                      WHERE tenant = ? AND uid = ?`
                  )
                  .run(current.tenant, current.uid)
                const manifest = database
                  .prepare(
                    `SELECT manifest_version
                       FROM user_manifests
                      WHERE tenant = ? AND uid = ?`
                  )
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
              return { _tag: "success", revision: advanced } as const
            })
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
        })

      const recordFailure = (
        input: RecordIngestFailure
      ): Effect.Effect<SourceRevision, InvalidSourceRevision | IngestManifestUnavailable> =>
        Effect.try({
          try: () => {
            if (input.code.trim().length === 0) {
              throw new InvalidSourceRevision({ field: "logicalSessionId", reason: "failure code must not be empty" })
            }
            const key = revisionKey(input.revision)
            const result = transaction(database, () => {
              const current = selectRevision(database, key)
              if (current === undefined) {
                throw new InvalidSourceRevision({
                  field: "sourceDigest",
                  reason: "does not name a stored source revision"
                })
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
            })
            return result
          },
          catch: (cause) =>
            cause instanceof InvalidSourceRevision
              ? cause
              : new IngestManifestUnavailable({ operation: "recordFailure", cause })
        })

      const read = (
        input: SourceRevisionIdentity
      ): Effect.Effect<SourceRevision | null, IngestManifestUnavailable> =>
        Effect.try({
          try: () => selectRevision(database, revisionKey(input)) ?? null,
          catch: (cause) => new IngestManifestUnavailable({ operation: "read", cause })
        })

      const readExtractionGeneration = (
        id: string
      ): Effect.Effect<ExtractionGenerationReference | null, InvalidSourceRevision | IngestManifestUnavailable> =>
        Effect.try({
          try: () => {
            if (id.trim().length === 0) {
              throw new InvalidSourceRevision({
                field: "extractionGeneration",
                reason: "id must not be empty"
              })
            }
            return selectExtractionGeneration(database, id) ?? null
          },
          catch: (cause) =>
            cause instanceof InvalidSourceRevision
              ? cause
              : new IngestManifestUnavailable({ operation: "readGeneration", cause })
        })

      const storeExtractionArtifact = (
        input: StoreExtractionArtifact
      ): Effect.Effect<
        ExtractionArtifact,
        | InvalidExtractionArtifact
        | ExtractionArtifactBindingMismatch
        | ExtractionArtifactStateInvalid
        | ExtractionArtifactConflict
        | IngestManifestUnavailable
      > =>
        Effect.try({
          try: () =>
            transaction(database, () => {
              const revision = selectRevisionByCommitId(database, input.revision.commitId)
              if (revision === undefined) {
                throw new ExtractionArtifactBindingMismatch({
                  commitId: input.revision.commitId,
                  reason: "unknownRevision"
                })
              }
              if (input.artifact.commitId !== revision.commitId) {
                throw new ExtractionArtifactBindingMismatch({
                  commitId: revision.commitId,
                  reason: "unknownRevision"
                })
              }
              if (input.artifact.sourceDigest !== revision.sourceDigest) {
                throw new ExtractionArtifactBindingMismatch({
                  commitId: revision.commitId,
                  reason: "sourceDigest"
                })
              }
              if (input.artifact.extractionGeneration !== revision.extractionGeneration) {
                throw new ExtractionArtifactBindingMismatch({
                  commitId: revision.commitId,
                  reason: "extractionGeneration"
                })
              }
              const parsed = parseExtractionArtifact(input.artifact.id, input.artifact.canonicalJson)
              if (parsed._tag === "Left") throw parsed.left
              const existing = selectExtractionArtifact(database, revision)
              if (existing !== undefined) {
                if (existing.canonicalJson !== parsed.right.canonicalJson) {
                  throw new ExtractionArtifactConflict({ commitId: revision.commitId })
                }
                return existing
              }
              if (revision.state === "RECEIVED" || revision.state === "COMMITTED") {
                throw new ExtractionArtifactStateInvalid({
                  commitId: revision.commitId,
                  state: revision.state
                })
              }
              database
                .prepare(
                  `INSERT INTO extraction_artifacts (commit_id, artifact_id, canonical_json, created_at_ms)
                   VALUES (?, ?, ?, ?)`
                )
                .run(revision.commitId, parsed.right.id, parsed.right.canonicalJson, Date.now())
              const stored = selectExtractionArtifact(database, revision)
              if (stored === undefined) throw new Error("inserted extraction artifact was not readable")
              return stored
            }),
          catch: (cause) =>
            cause instanceof InvalidExtractionArtifact ||
            cause instanceof ExtractionArtifactBindingMismatch ||
            cause instanceof ExtractionArtifactStateInvalid ||
            cause instanceof ExtractionArtifactConflict
              ? cause
              : new IngestManifestUnavailable({ operation: "storeExtractionArtifact", cause })
        })

      const readExtractionArtifact = (
        revision: SourceRevision
      ): Effect.Effect<ExtractionArtifact | null, IngestManifestUnavailable> =>
        Effect.try({
          try: () => selectExtractionArtifact(database, revision) ?? null,
          catch: (cause) => new IngestManifestUnavailable({ operation: "readExtractionArtifact", cause })
        })

      const applyProjectionDelta = (
        input: ApplyProjectionDelta
      ): Effect.Effect<
        ProjectionState,
        | InvalidProjectionDelta
        | ProjectionDeltaConflict
        | ProjectionVersionConflict
        | IngestManifestUnavailable
      > =>
        Effect.try({
          try: () =>
            transaction(database, () => {
              const source = selectRevisionByCommitId(database, input.revision.commitId)
              if (source === undefined) {
                throw new InvalidProjectionDelta({
                  field: "revision",
                  reason: "does not name a stored source revision"
                })
              }
              if (
                source.tenant !== input.revision.tenant ||
                source.uid !== input.revision.uid ||
                source.commitId !== input.revision.commitId
              ) {
                throw new InvalidProjectionDelta({
                  field: "revision",
                  reason: "does not match the stored source revision"
                })
              }
              if (source.state !== "CONSOLIDATED" && source.state !== "COMMITTED") {
                throw new InvalidProjectionDelta({
                  field: "revision",
                  reason: "must be consolidated before its projection can be activated"
                })
              }

              const payload = projectionPayload(input)
              const expectedManifestVersion =
                source.state === "COMMITTED" ? source.manifestVersion : source.manifestVersion + 1
              const existingDelta = database
                .prepare("SELECT canonical_delta FROM projection_deltas WHERE commit_id = ?")
                .get(source.commitId) as DatabaseRow | undefined
              if (existingDelta !== undefined) {
                if (text(existingDelta, "canonical_delta") !== payload.canonicalJson) {
                  throw new ProjectionDeltaConflict({ commitId: source.commitId })
                }
                const existingProjection = selectProjection(database, source)
                if (existingProjection === undefined) {
                  throw new Error("projection delta existed without a user projection")
                }
                return existingProjection
              }

              const current = selectProjection(database, source) ?? emptyProjection(source)
              if (current.manifestVersion !== expectedManifestVersion - 1) {
                throw new ProjectionVersionConflict({
                  tenant: source.tenant,
                  uid: source.uid,
                  expectedPreviousVersion: expectedManifestVersion - 1,
                  actualVersion: current.manifestVersion
                })
              }
              const nextStats = addStats(current.stats, payload.stats)
              const now = Date.now()
              database
                .prepare(
                  `INSERT INTO projection_deltas (
                    commit_id, tenant, uid, expected_manifest_version, canonical_delta, applied_at_ms
                  ) VALUES (?, ?, ?, ?, ?, ?)`
                )
                .run(
                  source.commitId,
                  source.tenant,
                  source.uid,
                  expectedManifestVersion,
                  payload.canonicalJson,
                  now
                )
              database
                .prepare(
                  `INSERT INTO user_projections (
                    tenant, uid, manifest_version, last_commit_id, last_reconciled_commit_id,
                    stats_json, consistency, updated_at_ms
                  ) VALUES (?, ?, ?, ?, ?, ?, 'consistent', ?)
                  ON CONFLICT(tenant, uid) DO UPDATE SET
                    manifest_version = excluded.manifest_version,
                    last_commit_id = excluded.last_commit_id,
                    last_reconciled_commit_id = excluded.last_reconciled_commit_id,
                    stats_json = excluded.stats_json,
                    consistency = 'consistent',
                    updated_at_ms = excluded.updated_at_ms`
                )
                .run(
                  source.tenant,
                  source.uid,
                  expectedManifestVersion,
                  source.commitId,
                  source.commitId,
                  statsJson(nextStats),
                  now
                )
              const applyCounts = (
                table: "projection_token_counts" | "projection_slot_counts",
                key: "token_key" | "slot_key",
                values: ReadonlyMap<string, number>
              ): void => {
                const insert = database.prepare(
                  `INSERT INTO ${table} (tenant, uid, ${key}, value) VALUES (?, ?, ?, ?)
                   ON CONFLICT(tenant, uid, ${key}) DO UPDATE SET value = value + excluded.value`
                )
                for (const [entry, value] of values) insert.run(source.tenant, source.uid, entry, value)
              }
              applyCounts("projection_token_counts", "token_key", payload.tokenDf)
              applyCounts("projection_slot_counts", "slot_key", payload.slotClaims)
              const applied = selectProjection(database, source)
              if (applied === undefined) throw new Error("applied projection was not readable")
              return applied
            }),
          catch: (cause) =>
            cause instanceof InvalidProjectionDelta ||
            cause instanceof ProjectionDeltaConflict ||
            cause instanceof ProjectionVersionConflict
              ? cause
              : new IngestManifestUnavailable({ operation: "applyProjectionDelta", cause })
        })

      const readProjection = (
        scope: IngestCommitScope
      ): Effect.Effect<ProjectionState, IngestManifestUnavailable> =>
        Effect.try({
          try: () => selectProjection(database, scope) ?? emptyProjection(scope),
          catch: (cause) => new IngestManifestUnavailable({ operation: "readProjection", cause })
        })

      const readProjectionCounts = (
        scope: IngestCommitScope
      ): Effect.Effect<ProjectionCounts, IngestManifestUnavailable> =>
        Effect.try({
          try: () => selectProjectionCounts(database, scope),
          catch: (cause) => new IngestManifestUnavailable({ operation: "readProjectionCounts", cause })
        })

      const reconcileProjection = (
        scope: IngestCommitScope
      ): Effect.Effect<ProjectionReconciliation, IngestManifestUnavailable> =>
        Effect.try({
          try: () =>
            transaction(database, () => {
              const deltas = database
                .prepare(
                  `SELECT commit_id, expected_manifest_version, canonical_delta
                     FROM projection_deltas
                    WHERE tenant = ? AND uid = ?
                    ORDER BY expected_manifest_version ASC`
                )
                .all(scope.tenant, scope.uid) as ReadonlyArray<DatabaseRow>
              const current = selectProjection(database, scope)
              if (deltas.length === 0 && current === undefined) {
                return { state: emptyProjection(scope), outcome: "unknown" } as const
              }

              let expectedVersion = 0
              let lastCommitId: string | null = null
              let rebuiltStats = EMPTY_STATS
              const rebuiltTokenDf = new Map<string, number>()
              const rebuiltSlotClaims = new Map<string, number>()
              for (const delta of deltas) {
                const version = integer(delta, "expected_manifest_version")
                if (version !== expectedVersion + 1) {
                  const stale = current ?? emptyProjection(scope)
                  database
                    .prepare(
                      `UPDATE user_projections
                          SET consistency = 'stale', updated_at_ms = ?
                        WHERE tenant = ? AND uid = ?`
                    )
                    .run(Date.now(), scope.tenant, scope.uid)
                  return { state: { ...stale, consistency: "stale" }, outcome: "unknown" } as const
                }
                expectedVersion = version
                lastCommitId = text(delta, "commit_id")
                const payload = decodeProjectionPayload(text(delta, "canonical_delta"))
                rebuiltStats = addStats(rebuiltStats, payload.stats)
                addCounts(rebuiltTokenDf, payload.tokenDf)
                addCounts(rebuiltSlotClaims, payload.slotClaims)
              }

              const existingCounts = selectProjectionCounts(database, scope)
              const expectedState: ProjectionState = {
                tenant: scope.tenant,
                uid: scope.uid,
                manifestVersion: expectedVersion,
                lastCommitId,
                lastReconciledCommitId: lastCommitId,
                stats: rebuiltStats,
                consistency: "consistent"
              }
              const isConsistent =
                current !== undefined &&
                current.manifestVersion === expectedState.manifestVersion &&
                current.lastCommitId === expectedState.lastCommitId &&
                current.lastReconciledCommitId === expectedState.lastReconciledCommitId &&
                current.consistency === "consistent" &&
                sameStats(current.stats, expectedState.stats) &&
                sameCounts(existingCounts.tokenDf, rebuiltTokenDf) &&
                sameCounts(existingCounts.slotClaims, rebuiltSlotClaims)
              if (isConsistent) return { state: current, outcome: "consistent" } as const

              database
                .prepare("DELETE FROM projection_token_counts WHERE tenant = ? AND uid = ?")
                .run(scope.tenant, scope.uid)
              database
                .prepare("DELETE FROM projection_slot_counts WHERE tenant = ? AND uid = ?")
                .run(scope.tenant, scope.uid)
              const insertCounts = (
                table: "projection_token_counts" | "projection_slot_counts",
                key: "token_key" | "slot_key",
                values: ReadonlyMap<string, number>
              ): void => {
                const insert = database.prepare(
                  `INSERT INTO ${table} (tenant, uid, ${key}, value) VALUES (?, ?, ?, ?)`
                )
                for (const [entry, value] of values) insert.run(scope.tenant, scope.uid, entry, value)
              }
              insertCounts("projection_token_counts", "token_key", rebuiltTokenDf)
              insertCounts("projection_slot_counts", "slot_key", rebuiltSlotClaims)
              database
                .prepare(
                  `INSERT INTO user_projections (
                    tenant, uid, manifest_version, last_commit_id, last_reconciled_commit_id,
                    stats_json, consistency, updated_at_ms
                  ) VALUES (?, ?, ?, ?, ?, ?, 'consistent', ?)
                  ON CONFLICT(tenant, uid) DO UPDATE SET
                    manifest_version = excluded.manifest_version,
                    last_commit_id = excluded.last_commit_id,
                    last_reconciled_commit_id = excluded.last_reconciled_commit_id,
                    stats_json = excluded.stats_json,
                    consistency = 'consistent',
                    updated_at_ms = excluded.updated_at_ms`
                )
                .run(
                  scope.tenant,
                  scope.uid,
                  expectedState.manifestVersion,
                  expectedState.lastCommitId,
                  expectedState.lastReconciledCommitId,
                  statsJson(expectedState.stats),
                  Date.now()
                )
              return { state: expectedState, outcome: "repaired" } as const
            }),
          catch: (cause) => new IngestManifestUnavailable({ operation: "reconcileProjection", cause })
        })

      const storeIndexGeneration = (
        input: StoreIndexGeneration
      ): Effect.Effect<
        IndexGeneration,
        | InvalidIndexGeneration
        | IndexGenerationConflict
        | IndexGenerationExtractionNotFound
        | IngestManifestUnavailable
      > =>
        Effect.try({
          try: () =>
            transaction(database, () => {
              const parsed = parseIndexGeneration(input.generation.id, input.generation.canonicalJson)
              if (parsed._tag === "Left") throw parsed.left
              if (selectExtractionGeneration(database, parsed.right.extractionGenerationId) === undefined) {
                throw new IndexGenerationExtractionNotFound({
                  extractionGenerationId: parsed.right.extractionGenerationId
                })
              }
              const existing = database
                .prepare(
                  `SELECT canonical_json
                     FROM index_generations
                    WHERE generation_id = ?`
                )
                .get(parsed.right.id) as DatabaseRow | undefined
              if (existing !== undefined) {
                if (text(existing, "canonical_json") !== parsed.right.canonicalJson) {
                  throw new IndexGenerationConflict({ generationId: parsed.right.id })
                }
                const stored = selectIndexGeneration(database, parsed.right.id)
                if (stored === undefined) throw new Error("stored index generation was not readable")
                return stored
              }
              database
                .prepare(
                  `INSERT INTO index_generations (
                    generation_id, extraction_generation, canonical_json, created_at_ms
                  ) VALUES (?, ?, ?, ?)`
                )
                .run(
                  parsed.right.id,
                  parsed.right.extractionGenerationId,
                  parsed.right.canonicalJson,
                  Date.now()
                )
              const stored = selectIndexGeneration(database, parsed.right.id)
              if (stored === undefined) throw new Error("inserted index generation was not readable")
              return stored
            }),
          catch: (cause) =>
            cause instanceof InvalidIndexGeneration ||
            cause instanceof IndexGenerationConflict ||
            cause instanceof IndexGenerationExtractionNotFound
              ? cause
              : new IngestManifestUnavailable({ operation: "storeIndexGeneration", cause })
        })

      const activateIndexGeneration = (
        input: ActivateIndexGeneration
      ): Effect.Effect<IndexGeneration, IndexGenerationNotFound | IngestManifestUnavailable> =>
        Effect.try({
          try: () =>
            transaction(database, () => {
              const generation = selectIndexGeneration(database, input.generationId)
              if (generation === undefined) {
                throw new IndexGenerationNotFound({ generationId: input.generationId })
              }
              database
                .prepare(
                  `INSERT INTO active_index_generations (tenant, uid, generation_id, activated_at_ms)
                   VALUES (?, ?, ?, ?)
                   ON CONFLICT(tenant, uid) DO UPDATE SET
                     generation_id = excluded.generation_id,
                     activated_at_ms = excluded.activated_at_ms`
                )
                .run(input.tenant, input.uid, generation.id, Date.now())
              return generation
            }),
          catch: (cause) =>
            cause instanceof IndexGenerationNotFound
              ? cause
              : new IngestManifestUnavailable({ operation: "activateIndexGeneration", cause })
        })

      const readActiveIndexGeneration = (
        scope: IndexGenerationScope
      ): Effect.Effect<IndexGeneration | null, IngestManifestUnavailable> =>
        Effect.try({
          try: () => {
            const pointer = database
              .prepare(
                `SELECT generation_id
                   FROM active_index_generations
                  WHERE tenant = ? AND uid = ?`
              )
              .get(scope.tenant, scope.uid) as DatabaseRow | undefined
            if (pointer === undefined) return null
            const generation = selectIndexGeneration(database, text(pointer, "generation_id"))
            if (generation === undefined) throw new Error("active index generation was not readable")
            return generation
          },
          catch: (cause) => new IngestManifestUnavailable({ operation: "readActiveIndexGeneration", cause })
        })

      const storeEntityCanonicalView = (
        input: StoreEntityCanonicalView
      ): Effect.Effect<EntityCanonicalView, EntityCanonicalViewConflict | IngestManifestUnavailable> =>
        Effect.try({
          try: () =>
            transaction(database, () => {
              const serialized = serializeEntityCanonicalView(input.view)
              const existing = database
                .prepare(
                  `SELECT canonical_json
                     FROM entity_canonical_views
                    WHERE tenant = ? AND uid = ? AND view_id = ?`
                )
                .get(input.tenant, input.uid, input.view.id) as DatabaseRow | undefined
              if (existing !== undefined) {
                if (text(existing, "canonical_json") !== serialized) {
                  throw new EntityCanonicalViewConflict({
                    tenant: input.tenant,
                    uid: input.uid,
                    viewId: input.view.id
                  })
                }
                const persisted = selectEntityCanonicalView(database, input, input.view.id)
                if (persisted === undefined) throw new Error("stored entity canonical view was not readable")
                return persisted
              }
              database
                .prepare(
                  `INSERT INTO entity_canonical_views (tenant, uid, view_id, canonical_json, created_at_ms)
                   VALUES (?, ?, ?, ?, ?)`
                )
                .run(input.tenant, input.uid, input.view.id, serialized, Date.now())
              const insertEdge = database.prepare(
                `INSERT INTO entity_canonical_view_edges (
                  tenant, uid, view_id, from_identity_id, to_canonical_identity_id
                ) VALUES (?, ?, ?, ?, ?)`
              )
              for (const edge of input.view.sameAs) {
                insertEdge.run(
                  input.tenant,
                  input.uid,
                  input.view.id,
                  edge.fromIdentityId,
                  edge.toCanonicalIdentityId
                )
              }
              const stored = selectEntityCanonicalView(database, input, input.view.id)
              if (stored === undefined) throw new Error("inserted entity canonical view was not readable")
              return stored
            }),
          catch: (cause) =>
            cause instanceof EntityCanonicalViewConflict
              ? cause
              : new IngestManifestUnavailable({ operation: "storeEntityCanonicalView", cause })
        })

      const activateEntityCanonicalView = (
        input: ActivateEntityCanonicalView
      ): Effect.Effect<
        EntityCanonicalView,
        EntityCanonicalViewNotFound | IngestManifestUnavailable
      > =>
        Effect.try({
          try: () =>
            transaction(database, () => {
              const view = selectEntityCanonicalView(database, input, input.viewId)
              if (view === undefined) {
                throw new EntityCanonicalViewNotFound({
                  tenant: input.tenant,
                  uid: input.uid,
                  viewId: input.viewId
                })
              }
              database
                .prepare(
                  `INSERT INTO active_entity_canonical_views (tenant, uid, view_id, activated_at_ms)
                   VALUES (?, ?, ?, ?)
                   ON CONFLICT(tenant, uid) DO UPDATE SET
                     view_id = excluded.view_id,
                     activated_at_ms = excluded.activated_at_ms`
                )
                .run(input.tenant, input.uid, input.viewId, Date.now())
              return view
            }),
          catch: (cause) =>
            cause instanceof EntityCanonicalViewNotFound
              ? cause
              : new IngestManifestUnavailable({ operation: "activateEntityCanonicalView", cause })
        })

      const readActiveEntityCanonicalView = (
        scope: EntityCanonicalViewScope
      ): Effect.Effect<EntityCanonicalView | null, IngestManifestUnavailable> =>
        Effect.try({
          try: () => {
            const pointer = database
              .prepare(
                `SELECT view_id
                   FROM active_entity_canonical_views
                  WHERE tenant = ? AND uid = ?`
              )
              .get(scope.tenant, scope.uid) as DatabaseRow | undefined
            if (pointer === undefined) return null
            const view = selectEntityCanonicalView(database, scope, text(pointer, "view_id"))
            if (view === undefined) throw new Error("active entity canonical view was not readable")
            return view
          },
          catch: (cause) => new IngestManifestUnavailable({ operation: "readActiveEntityCanonicalView", cause })
        })

      return {
        begin,
        advance,
        recordFailure,
        read,
        readExtractionGeneration,
        storeExtractionArtifact,
        readExtractionArtifact,
        applyProjectionDelta,
        readProjection,
        readProjectionCounts,
        reconcileProjection,
        storeIndexGeneration,
        activateIndexGeneration,
        readActiveIndexGeneration,
        storeEntityCanonicalView,
        activateEntityCanonicalView,
        readActiveEntityCanonicalView
      } as const
    })
  )

/** Transactional source-revision and per-user-order capability. */
export interface IngestManifestService {
  /** Claim a source revision or return its resumable/committed state. */
  readonly begin: (
    input: BeginSourceRevision
  ) => Effect.Effect<BeginSourceRevisionResult, IngestManifestError>
  /** Advance exactly one durable ingest stage. */
  readonly advance: (
    input: AdvanceIngestState
  ) => Effect.Effect<
    SourceRevision,
    InvalidIngestTransition | IngestRevisionBlocked | IngestManifestUnavailable
  >
  /** Record a safe, retryable-or-terminal failure without falsely committing. */
  readonly recordFailure: (
    input: RecordIngestFailure
  ) => Effect.Effect<SourceRevision, InvalidSourceRevision | IngestManifestUnavailable>
  /** Read one source revision by its immutable identity. */
  readonly read: (
    input: SourceRevisionIdentity
  ) => Effect.Effect<SourceRevision | null, IngestManifestUnavailable>
  /** Return the exact descriptor previously bound to an extraction-generation id. */
  readonly readExtractionGeneration: (
    id: string
  ) => Effect.Effect<ExtractionGenerationReference | null, InvalidSourceRevision | IngestManifestUnavailable>
  /** Persist verified extraction output for a source-durable revision. */
  readonly storeExtractionArtifact: (
    input: StoreExtractionArtifact
  ) => Effect.Effect<
    ExtractionArtifact,
    | InvalidExtractionArtifact
    | ExtractionArtifactBindingMismatch
    | ExtractionArtifactStateInvalid
    | ExtractionArtifactConflict
    | IngestManifestUnavailable
  >
  /** Read verified extraction output for a revision, without calling a provider. */
  readonly readExtractionArtifact: (
    revision: SourceRevision
  ) => Effect.Effect<ExtractionArtifact | null, IngestManifestUnavailable>
  /** Apply one commit-id-keyed delta to the rebuildable per-user projections. */
  readonly applyProjectionDelta: (
    input: ApplyProjectionDelta
  ) => Effect.Effect<
    ProjectionState,
    | InvalidProjectionDelta
    | ProjectionDeltaConflict
    | ProjectionVersionConflict
    | IngestManifestUnavailable
  >
  /** Return projection totals with an explicit consistency state. */
  readonly readProjection: (
    scope: IngestCommitScope
  ) => Effect.Effect<ProjectionState, IngestManifestUnavailable>
  /** Return scoped Token/Slot projection values without a store-wide graph scan. */
  readonly readProjectionCounts: (
    scope: IngestCommitScope
  ) => Effect.Effect<ProjectionCounts, IngestManifestUnavailable>
  /** Rebuild one user's projections from its durable commit deltas. */
  readonly reconcileProjection: (
    scope: IngestCommitScope
  ) => Effect.Effect<ProjectionReconciliation, IngestManifestUnavailable>
  /** Persist one immutable, content-addressed derived index generation. */
  readonly storeIndexGeneration: (
    input: StoreIndexGeneration
  ) => Effect.Effect<
    IndexGeneration,
    | InvalidIndexGeneration
    | IndexGenerationConflict
    | IndexGenerationExtractionNotFound
    | IngestManifestUnavailable
  >
  /** Atomically select one stored index generation for a user. */
  readonly activateIndexGeneration: (
    input: ActivateIndexGeneration
  ) => Effect.Effect<IndexGeneration, IndexGenerationNotFound | IngestManifestUnavailable>
  /** Read the selected index generation, if this user has activated one. */
  readonly readActiveIndexGeneration: (
    scope: IndexGenerationScope
  ) => Effect.Effect<IndexGeneration | null, IngestManifestUnavailable>
  /** Persist one immutable, content-addressed Entity canonical view. */
  readonly storeEntityCanonicalView: (
    input: StoreEntityCanonicalView
  ) => Effect.Effect<EntityCanonicalView, EntityCanonicalViewConflict | IngestManifestUnavailable>
  /** Atomically select a stored Entity canonical view for one user. */
  readonly activateEntityCanonicalView: (
    input: ActivateEntityCanonicalView
  ) => Effect.Effect<EntityCanonicalView, EntityCanonicalViewNotFound | IngestManifestUnavailable>
  /** Read the selected Entity canonical view, if this user has activated one. */
  readonly readActiveEntityCanonicalView: (
    scope: EntityCanonicalViewScope
  ) => Effect.Effect<EntityCanonicalView | null, IngestManifestUnavailable>
}

/**
 * Transactional authority for source-revision ingest state and per-user order.
 *
 * HydraDB remains the retrieval data plane; this service owns the CAS-like
 * state transitions HydraDB does not provide.
 */
export class IngestManifest extends Context.Tag("palimpsest/IngestManifest")<
  IngestManifest,
  IngestManifestService
>() {}

/** Production layer backed by the configured durable SQLite manifest file. */
export const IngestManifestLive = Layer.scoped(
  IngestManifest,
  Config.string("PALIMPSEST_INGEST_MANIFEST_PATH").pipe(
    Config.withDefault(".palimpsest/ingest-manifest.sqlite"),
    Effect.flatMap(makeService)
  )
)

/** A real in-memory SQLite implementation for hermetic contract tests. */
export const IngestManifestLayerMemory = Layer.scoped(IngestManifest, makeService(":memory:"))
