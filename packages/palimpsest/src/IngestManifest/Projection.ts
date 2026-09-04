import type { DatabaseSync } from "node:sqlite"
import { Effect } from "effect"
import type { IngestCommitScope } from "../IngestCommitLock.js"
import { EMPTY_STATS } from "../User.js"
import {
  addCounts,
  addStats,
  decodeProjectionPayload,
  decodeStatsJson,
  projectionPayload,
  sameCounts,
  sameStats,
  statsJson
} from "./Codec.js"
import { integer, nullableText, selectRevisionByCommitId, text, transaction, type DatabaseRow } from "./Rows.js"
import {
  IngestManifestUnavailable,
  InvalidProjectionDelta,
  ProjectionDeltaConflict,
  ProjectionVersionConflict,
  type ApplyProjectionDelta,
  type ProjectionCounts,
  type ProjectionReconciliation,
  type ProjectionState
} from "./Types.js"

export interface ProjectionOperations {
  readonly applyProjectionDelta: (
    input: ApplyProjectionDelta
  ) => Effect.Effect<
    ProjectionState,
    | InvalidProjectionDelta
    | ProjectionDeltaConflict
    | ProjectionVersionConflict
    | IngestManifestUnavailable
  >
  readonly readProjection: (
    scope: IngestCommitScope
  ) => Effect.Effect<ProjectionState, IngestManifestUnavailable>
  readonly readProjectionCounts: (
    scope: IngestCommitScope
  ) => Effect.Effect<ProjectionCounts, IngestManifestUnavailable>
  readonly reconcileProjection: (
    scope: IngestCommitScope
  ) => Effect.Effect<ProjectionReconciliation, IngestManifestUnavailable>
}

type CountTable = "projection_token_counts" | "projection_slot_counts"
type CountKey = "token_key" | "slot_key"

const emptyProjection = (scope: IngestCommitScope): ProjectionState => ({
  tenant: scope.tenant,
  uid: scope.uid,
  manifestVersion: 0,
  lastCommitId: null,
  lastReconciledCommitId: null,
  stats: EMPTY_STATS,
  consistency: "unknown"
})

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

const selectProjectionCounts = (database: DatabaseSync, scope: IngestCommitScope): ProjectionCounts => {
  const select = (table: CountTable, key: CountKey): ReadonlyMap<string, number> => {
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

const upsertProjection = (database: DatabaseSync, state: ProjectionState, now: number): void => {
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
      state.tenant,
      state.uid,
      state.manifestVersion,
      state.lastCommitId,
      state.lastReconciledCommitId,
      statsJson(state.stats),
      now
    )
}

const applyDelta = (database: DatabaseSync, input: ApplyProjectionDelta): ProjectionState => {
  const source = selectRevisionByCommitId(database, input.revision.commitId)
  if (source === undefined) {
    throw new InvalidProjectionDelta({ field: "revision", reason: "does not name a stored source revision" })
  }
  if (
    source.tenant !== input.revision.tenant ||
    source.uid !== input.revision.uid ||
    source.commitId !== input.revision.commitId
  ) {
    throw new InvalidProjectionDelta({ field: "revision", reason: "does not match the stored source revision" })
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
    if (existingProjection === undefined) throw new Error("projection delta existed without a user projection")
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
  const now = Date.now()
  database
    .prepare(
      `INSERT INTO projection_deltas (
        commit_id, tenant, uid, expected_manifest_version, canonical_delta, applied_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(source.commitId, source.tenant, source.uid, expectedManifestVersion, payload.canonicalJson, now)
  upsertProjection(
    database,
    {
      tenant: source.tenant,
      uid: source.uid,
      manifestVersion: expectedManifestVersion,
      lastCommitId: source.commitId,
      lastReconciledCommitId: source.commitId,
      stats: addStats(current.stats, payload.stats),
      consistency: "consistent"
    },
    now
  )
  const addCountRows = (table: CountTable, key: CountKey, values: ReadonlyMap<string, number>): void => {
    const insert = database.prepare(
      `INSERT INTO ${table} (tenant, uid, ${key}, value) VALUES (?, ?, ?, ?)
       ON CONFLICT(tenant, uid, ${key}) DO UPDATE SET value = value + excluded.value`
    )
    for (const [entry, value] of values) insert.run(source.tenant, source.uid, entry, value)
  }
  addCountRows("projection_token_counts", "token_key", payload.tokenDf)
  addCountRows("projection_slot_counts", "slot_key", payload.slotClaims)
  const applied = selectProjection(database, source)
  if (applied === undefined) throw new Error("applied projection was not readable")
  return applied
}

const reconcile = (database: DatabaseSync, scope: IngestCommitScope): ProjectionReconciliation => {
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
    return { state: emptyProjection(scope), outcome: "unknown" }
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
        .prepare(`UPDATE user_projections SET consistency = 'stale', updated_at_ms = ? WHERE tenant = ? AND uid = ?`)
        .run(Date.now(), scope.tenant, scope.uid)
      return { state: { ...stale, consistency: "stale" }, outcome: "unknown" }
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
  if (isConsistent) return { state: current, outcome: "consistent" }

  database.prepare("DELETE FROM projection_token_counts WHERE tenant = ? AND uid = ?").run(scope.tenant, scope.uid)
  database.prepare("DELETE FROM projection_slot_counts WHERE tenant = ? AND uid = ?").run(scope.tenant, scope.uid)
  const insertCountRows = (table: CountTable, key: CountKey, values: ReadonlyMap<string, number>): void => {
    const insert = database.prepare(`INSERT INTO ${table} (tenant, uid, ${key}, value) VALUES (?, ?, ?, ?)`)
    for (const [entry, value] of values) insert.run(scope.tenant, scope.uid, entry, value)
  }
  insertCountRows("projection_token_counts", "token_key", rebuiltTokenDf)
  insertCountRows("projection_slot_counts", "slot_key", rebuiltSlotClaims)
  upsertProjection(database, expectedState, Date.now())
  return { state: expectedState, outcome: "repaired" }
}

export const makeProjectionOperations = (database: DatabaseSync): ProjectionOperations => ({
  applyProjectionDelta: (input) =>
    Effect.try({
      try: () => transaction(database, () => applyDelta(database, input)),
      catch: (cause) =>
        cause instanceof InvalidProjectionDelta ||
        cause instanceof ProjectionDeltaConflict ||
        cause instanceof ProjectionVersionConflict
          ? cause
          : new IngestManifestUnavailable({ operation: "applyProjectionDelta", cause })
    }),

  readProjection: (scope) =>
    Effect.try({
      try: () => selectProjection(database, scope) ?? emptyProjection(scope),
      catch: (cause) => new IngestManifestUnavailable({ operation: "readProjection", cause })
    }),

  readProjectionCounts: (scope) =>
    Effect.try({
      try: () => selectProjectionCounts(database, scope),
      catch: (cause) => new IngestManifestUnavailable({ operation: "readProjectionCounts", cause })
    }),

  reconcileProjection: (scope) =>
    Effect.try({
      try: () => transaction(database, () => reconcile(database, scope)),
      catch: (cause) => new IngestManifestUnavailable({ operation: "reconcileProjection", cause })
    })
})
