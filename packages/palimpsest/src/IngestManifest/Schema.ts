import { DatabaseSync } from "node:sqlite"
import { Schema } from "effect"
import { memoryScopeFromRevision } from "../MemoryScope.js"
import { integer, nullableBoolean, nullableText, revisionKey, text } from "./Rows.js"

/** Current SQLite manifest schema (`PRAGMA user_version`); recorded inside every snapshot descriptor. */
export const MANIFEST_SCHEMA_VERSION = 10

class UnsupportedManifestSchemaVersion extends Error {
  readonly _tag = "UnsupportedManifestSchemaVersion" as const

  constructor(readonly actualVersion: number) {
    super(
      `manifest schema version ${actualVersion} is newer than supported version ${MANIFEST_SCHEMA_VERSION}`
    )
    this.name = "UnsupportedManifestSchemaVersion"
  }
}

const V2_REVISION_IDENTITY =
  "UNIQUE (tenant, uid, logical_session_id, source_digest, extraction_generation)"

const TABLES = `
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
    ${V2_REVISION_IDENTITY}
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

  CREATE TABLE IF NOT EXISTS graph_id_claims (
    reduced_id INTEGER NOT NULL CHECK (reduced_id >= 0),
    kind TEXT NOT NULL CHECK (kind IN ('vertex', 'relationship')),
    canonical_identity TEXT NOT NULL CHECK (length(canonical_identity) > 0),
    claimed_at_ms INTEGER NOT NULL,
    PRIMARY KEY (reduced_id, kind)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS graph_id_quarantine (
    reduced_id INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('vertex', 'relationship')),
    existing_identity TEXT NOT NULL,
    rejected_identity TEXT NOT NULL,
    detected_at_ms INTEGER NOT NULL,
    PRIMARY KEY (reduced_id, kind)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS user_index_snapshots (
    snapshot_id TEXT PRIMARY KEY,
    tenant TEXT NOT NULL,
    uid TEXT NOT NULL,
    generation_id TEXT NOT NULL,
    canonical_view_id TEXT NOT NULL,
    manifest_schema_version INTEGER NOT NULL CHECK (manifest_schema_version >= 1),
    source_revisions_hash TEXT NOT NULL,
    source_revision_count INTEGER NOT NULL CHECK (source_revision_count >= 0),
    state TEXT NOT NULL CHECK (state IN ('BUILDING', 'VERIFIED', 'ACTIVE', 'SUPERSEDED', 'FAILED')),
    build_attempt INTEGER NOT NULL CHECK (build_attempt >= 1),
    verification_digest TEXT,
    graph_roots_json TEXT,
    counts_json TEXT,
    failure_code TEXT,
    canonical_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    FOREIGN KEY (generation_id) REFERENCES index_generations (generation_id),
    FOREIGN KEY (tenant, uid, canonical_view_id)
      REFERENCES entity_canonical_views (tenant, uid, view_id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS user_index_snapshot_revisions (
    snapshot_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    commit_id TEXT NOT NULL,
    PRIMARY KEY (snapshot_id, position),
    UNIQUE (snapshot_id, commit_id),
    FOREIGN KEY (snapshot_id) REFERENCES user_index_snapshots (snapshot_id),
    FOREIGN KEY (commit_id) REFERENCES source_revisions (commit_id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS active_index_snapshots (
    tenant TEXT NOT NULL,
    uid TEXT NOT NULL,
    snapshot_id TEXT NOT NULL,
    manifest_version INTEGER NOT NULL CHECK (manifest_version >= 0),
    activated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (tenant, uid),
    FOREIGN KEY (snapshot_id) REFERENCES user_index_snapshots (snapshot_id)
  ) STRICT;
`

const migrateRevisionsV1 = (database: DatabaseSync): void => {
  const legacyRows = database
    .prepare(`
      SELECT tenant, uid, logical_session_id, source_digest, source_bytes,
             extraction_generation, session_ordinal, commit_id, state, manifest_version,
             failure_code, failure_retryable, created_at_ms, updated_at_ms
        FROM source_revisions_v1
    `)
    .all()
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
      revisionKey(memoryScopeFromRevision(identity), identity),
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
      failureRetryable === null ? null : failureRetryable ? 1 : 0,
      integer(row, "created_at_ms"),
      integer(row, "updated_at_ms")
    )
  }
  database.exec("DROP TABLE source_revisions_v1")
}

/** Rewrite delimiter-joined v2 keys to the canonical S01 framing in place. */
const migrateRevisionKeysV3 = (database: DatabaseSync): void => {
  const rows = database
    .prepare(`
      SELECT revision_key, tenant, uid, logical_session_id, source_digest, extraction_generation
        FROM source_revisions
    `)
    .all()
  const update = database.prepare(`UPDATE source_revisions SET revision_key = ? WHERE revision_key = ?`)
  for (const row of rows) {
    const identity = {
      tenant: text(row, "tenant"),
      uid: text(row, "uid"),
      logicalSessionId: text(row, "logical_session_id"),
      sourceDigest: text(row, "source_digest"),
      extractionGeneration: text(row, "extraction_generation")
    }
    const previous = text(row, "revision_key")
    const canonical = revisionKey(memoryScopeFromRevision(identity), identity)
    if (canonical !== previous) update.run(canonical, previous)
  }
}

export const createDatabase = (path: string): DatabaseSync => {
  const database = new DatabaseSync(path, {
    enableForeignKeyConstraints: true,
    timeout: 5_000
  })
  try {
    const versionRow = database.prepare("PRAGMA user_version").get()
    if (versionRow === undefined) throw new Error("manifest schema version was not readable")
    const actualVersion = integer(versionRow, "user_version")
    if (actualVersion > MANIFEST_SCHEMA_VERSION) {
      throw new UnsupportedManifestSchemaVersion(actualVersion)
    }
    database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;")
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
      .get()
    const sql = existing?.["sql"]
    const oldIdentity = Schema.is(Schema.String)(sql) && !sql.includes(V2_REVISION_IDENTITY)
    if (oldIdentity) database.exec("ALTER TABLE source_revisions RENAME TO source_revisions_v1")

    database.exec(TABLES)
    if (oldIdentity) migrateRevisionsV1(database)
    migrateRevisionKeysV3(database)
    database.exec(`
      CREATE INDEX IF NOT EXISTS source_revisions_logical_session
        ON source_revisions (tenant, uid, logical_session_id, extraction_generation, created_at_ms);
      CREATE INDEX IF NOT EXISTS user_index_snapshots_scope
        ON user_index_snapshots (tenant, uid, created_at_ms, snapshot_id);
      PRAGMA user_version = ${MANIFEST_SCHEMA_VERSION};
      COMMIT;
    `)
  } catch (cause) {
    try {
      database.exec("ROLLBACK")
    } catch {
      // no open transaction when the open itself failed
    }
    database.close()
    throw cause
  }
  return database
}
