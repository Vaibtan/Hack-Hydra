import type { DatabaseSync } from "node:sqlite"
import { Effect } from "effect"
import { InvalidIndexGeneration, parseIndexGeneration, type IndexGeneration } from "../IndexGeneration.js"
import { selectExtractionGeneration } from "./Revisions.js"
import { text, transaction } from "./Rows.js"
import {
  IndexGenerationConflict,
  IndexGenerationExtractionNotFound,
  IndexGenerationNotFound,
  IngestManifestUnavailable,
  type ActivateIndexGeneration,
  type IndexGenerationScope,
  type StoreIndexGeneration
} from "./Types.js"

export interface GenerationOperations {
  readonly storeIndexGeneration: (
    input: StoreIndexGeneration
  ) => Effect.Effect<
    IndexGeneration,
    | InvalidIndexGeneration
    | IndexGenerationConflict
    | IndexGenerationExtractionNotFound
    | IngestManifestUnavailable
  >
  readonly activateIndexGeneration: (
    input: ActivateIndexGeneration
  ) => Effect.Effect<IndexGeneration, IndexGenerationNotFound | IngestManifestUnavailable>
  readonly readActiveIndexGeneration: (
    scope: IndexGenerationScope
  ) => Effect.Effect<IndexGeneration | null, IngestManifestUnavailable>
  /** Read one stored generation by id, regardless of which generation is active. */
  readonly readIndexGeneration: (
    generationId: string
  ) => Effect.Effect<IndexGeneration | null, IngestManifestUnavailable>
}

const selectIndexGeneration = (database: DatabaseSync, generationId: string): IndexGeneration | undefined => {
  const row = database
    .prepare(`SELECT generation_id, extraction_generation, canonical_json FROM index_generations WHERE generation_id = ?`)
    .get(generationId)
  if (row === undefined) return undefined
  const parsed = parseIndexGeneration(text(row, "generation_id"), text(row, "canonical_json"))
  if (parsed._tag === "Failure") throw new Error(`stored index generation ${generationId} was invalid`)
  if (parsed.success.extractionGenerationId !== text(row, "extraction_generation")) {
    throw new Error(`stored index generation ${generationId} had an inconsistent extraction reference`)
  }
  if (selectExtractionGeneration(database, parsed.success.extractionGenerationId) === undefined) {
    throw new Error(`stored index generation ${generationId} referenced a missing extraction generation`)
  }
  return parsed.success
}

const storeGeneration = (database: DatabaseSync, input: StoreIndexGeneration): IndexGeneration => {
  const parsed = parseIndexGeneration(input.generation.id, input.generation.canonicalJson)
  if (parsed._tag === "Failure") throw parsed.failure
  if (selectExtractionGeneration(database, parsed.success.extractionGenerationId) === undefined) {
    throw new IndexGenerationExtractionNotFound({ extractionGenerationId: parsed.success.extractionGenerationId })
  }
  const existing = database
    .prepare(`SELECT canonical_json FROM index_generations WHERE generation_id = ?`)
    .get(parsed.success.id)
  if (existing !== undefined) {
    if (text(existing, "canonical_json") !== parsed.success.canonicalJson) {
      throw new IndexGenerationConflict({ generationId: parsed.success.id })
    }
    const stored = selectIndexGeneration(database, parsed.success.id)
    if (stored === undefined) throw new Error("stored index generation was not readable")
    return stored
  }
  database
    .prepare(
      `INSERT INTO index_generations (generation_id, extraction_generation, canonical_json, created_at_ms)
       VALUES (?, ?, ?, ?)`
    )
    .run(parsed.success.id, parsed.success.extractionGenerationId, parsed.success.canonicalJson, Date.now())
  const stored = selectIndexGeneration(database, parsed.success.id)
  if (stored === undefined) throw new Error("inserted index generation was not readable")
  return stored
}

const activateGeneration = (database: DatabaseSync, input: ActivateIndexGeneration): IndexGeneration => {
  const generation = selectIndexGeneration(database, input.generationId)
  if (generation === undefined) throw new IndexGenerationNotFound({ generationId: input.generationId })
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
}

const readActiveGeneration = (database: DatabaseSync, scope: IndexGenerationScope): IndexGeneration | null => {
  const pointer = database
    .prepare(`SELECT generation_id FROM active_index_generations WHERE tenant = ? AND uid = ?`)
    .get(scope.tenant, scope.uid)
  if (pointer === undefined) return null
  const generation = selectIndexGeneration(database, text(pointer, "generation_id"))
  if (generation === undefined) throw new Error("active index generation was not readable")
  return generation
}

export const createGenerationOperations = (database: DatabaseSync): GenerationOperations => ({
  storeIndexGeneration: (input) =>
    Effect.try({
      try: () => transaction(database, () => storeGeneration(database, input)),
      catch: (cause) =>
        cause instanceof InvalidIndexGeneration ||
        cause instanceof IndexGenerationConflict ||
        cause instanceof IndexGenerationExtractionNotFound
          ? cause
          : new IngestManifestUnavailable({ operation: "storeIndexGeneration", cause })
    }),

  activateIndexGeneration: (input) =>
    Effect.try({
      try: () => transaction(database, () => activateGeneration(database, input)),
      catch: (cause) =>
        cause instanceof IndexGenerationNotFound
          ? cause
          : new IngestManifestUnavailable({ operation: "activateIndexGeneration", cause })
    }),

  readActiveIndexGeneration: (scope) =>
    Effect.try({
      try: () => readActiveGeneration(database, scope),
      catch: (cause) => new IngestManifestUnavailable({ operation: "readActiveIndexGeneration", cause })
    }),

  readIndexGeneration: (generationId) =>
    Effect.try({
      try: () => selectIndexGeneration(database, generationId) ?? null,
      catch: (cause) => new IngestManifestUnavailable({ operation: "readIndexGeneration", cause })
    })
})
