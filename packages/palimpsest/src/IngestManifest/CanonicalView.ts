import type { DatabaseSync } from "node:sqlite"
import { Effect } from "effect"
import {
  parseEntityCanonicalView,
  serializeEntityCanonicalView,
  type EntityCanonicalView
} from "../EntityCanonicalView.js"
import { text, transaction, type DatabaseRow } from "./Rows.js"
import {
  EntityCanonicalViewConflict,
  EntityCanonicalViewNotFound,
  IngestManifestUnavailable,
  type ActivateEntityCanonicalView,
  type EntityCanonicalViewScope,
  type StoreEntityCanonicalView
} from "./Types.js"

export interface CanonicalViewOperations {
  readonly storeEntityCanonicalView: (
    input: StoreEntityCanonicalView
  ) => Effect.Effect<EntityCanonicalView, EntityCanonicalViewConflict | IngestManifestUnavailable>
  readonly activateEntityCanonicalView: (
    input: ActivateEntityCanonicalView
  ) => Effect.Effect<EntityCanonicalView, EntityCanonicalViewNotFound | IngestManifestUnavailable>
  readonly readActiveEntityCanonicalView: (
    scope: EntityCanonicalViewScope
  ) => Effect.Effect<EntityCanonicalView | null, IngestManifestUnavailable>
}

const sameStringMap = (left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): boolean =>
  left.size === right.size && [...left].every(([key, value]) => right.get(key) === value)

const selectEntityCanonicalView = (
  database: DatabaseSync,
  scope: EntityCanonicalViewScope,
  viewId: string
): EntityCanonicalView | undefined => {
  const row = database
    .prepare(`SELECT canonical_json FROM entity_canonical_views WHERE tenant = ? AND uid = ? AND view_id = ?`)
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
  const expectedEdges = new Map(parsed.right.sameAs.map((edge) => [edge.fromIdentityId, edge.toCanonicalIdentityId]))
  if (!sameStringMap(persistedEdges, expectedEdges)) {
    throw new Error(`stored entity canonical view edges for ${viewId} were invalid`)
  }
  return parsed.right
}

const storeView = (database: DatabaseSync, input: StoreEntityCanonicalView): EntityCanonicalView => {
  const serialized = serializeEntityCanonicalView(input.view)
  const existing = database
    .prepare(`SELECT canonical_json FROM entity_canonical_views WHERE tenant = ? AND uid = ? AND view_id = ?`)
    .get(input.tenant, input.uid, input.view.id) as DatabaseRow | undefined
  if (existing !== undefined) {
    if (text(existing, "canonical_json") !== serialized) {
      throw new EntityCanonicalViewConflict({ tenant: input.tenant, uid: input.uid, viewId: input.view.id })
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
    `INSERT INTO entity_canonical_view_edges (tenant, uid, view_id, from_identity_id, to_canonical_identity_id)
     VALUES (?, ?, ?, ?, ?)`
  )
  for (const edge of input.view.sameAs) {
    insertEdge.run(input.tenant, input.uid, input.view.id, edge.fromIdentityId, edge.toCanonicalIdentityId)
  }
  const stored = selectEntityCanonicalView(database, input, input.view.id)
  if (stored === undefined) throw new Error("inserted entity canonical view was not readable")
  return stored
}

const activateView = (database: DatabaseSync, input: ActivateEntityCanonicalView): EntityCanonicalView => {
  const view = selectEntityCanonicalView(database, input, input.viewId)
  if (view === undefined) {
    throw new EntityCanonicalViewNotFound({ tenant: input.tenant, uid: input.uid, viewId: input.viewId })
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
}

const readActiveView = (database: DatabaseSync, scope: EntityCanonicalViewScope): EntityCanonicalView | null => {
  const pointer = database
    .prepare(`SELECT view_id FROM active_entity_canonical_views WHERE tenant = ? AND uid = ?`)
    .get(scope.tenant, scope.uid) as DatabaseRow | undefined
  if (pointer === undefined) return null
  const view = selectEntityCanonicalView(database, scope, text(pointer, "view_id"))
  if (view === undefined) throw new Error("active entity canonical view was not readable")
  return view
}

export const makeCanonicalViewOperations = (database: DatabaseSync): CanonicalViewOperations => ({
  storeEntityCanonicalView: (input) =>
    Effect.try({
      try: () => transaction(database, () => storeView(database, input)),
      catch: (cause) =>
        cause instanceof EntityCanonicalViewConflict
          ? cause
          : new IngestManifestUnavailable({ operation: "storeEntityCanonicalView", cause })
    }),

  activateEntityCanonicalView: (input) =>
    Effect.try({
      try: () => transaction(database, () => activateView(database, input)),
      catch: (cause) =>
        cause instanceof EntityCanonicalViewNotFound
          ? cause
          : new IngestManifestUnavailable({ operation: "activateEntityCanonicalView", cause })
    }),

  readActiveEntityCanonicalView: (scope) =>
    Effect.try({
      try: () => readActiveView(database, scope),
      catch: (cause) => new IngestManifestUnavailable({ operation: "readActiveEntityCanonicalView", cause })
    })
})
