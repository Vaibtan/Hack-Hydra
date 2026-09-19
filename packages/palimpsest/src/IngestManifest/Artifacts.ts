import type { DatabaseSync } from "node:sqlite"
import { Effect } from "effect"
import {
  InvalidExtractionArtifact,
  parseExtractionArtifact,
  type ExtractionArtifact
} from "../ExtractionArtifact.js"
import { selectRevisionByCommitId, text, transaction } from "./Rows.js"
import {
  ExtractionArtifactBindingMismatch,
  ExtractionArtifactConflict,
  ExtractionArtifactStateInvalid,
  IngestManifestUnavailable,
  type SourceRevision,
  type StoreExtractionArtifact
} from "./Types.js"

export interface ArtifactOperations {
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
  readonly readExtractionArtifact: (
    revision: SourceRevision
  ) => Effect.Effect<ExtractionArtifact | null, IngestManifestUnavailable>
}

const selectExtractionArtifact = (
  database: DatabaseSync,
  revision: SourceRevision
): ExtractionArtifact | undefined => {
  const row = database
    .prepare(`SELECT artifact_id, canonical_json FROM extraction_artifacts WHERE commit_id = ?`)
    .get(revision.commitId)
  if (row === undefined) return undefined
  const parsed = parseExtractionArtifact(text(row, "artifact_id"), text(row, "canonical_json"))
  if (parsed._tag === "Failure") throw new Error(`stored extraction artifact ${revision.commitId} was invalid`)
  if (
    parsed.success.commitId !== revision.commitId ||
    parsed.success.sourceDigest !== revision.sourceDigest ||
    parsed.success.extractionGeneration !== revision.extractionGeneration
  ) {
    throw new Error(`stored extraction artifact ${revision.commitId} had an invalid revision binding`)
  }
  return parsed.success
}

const storeArtifact = (database: DatabaseSync, input: StoreExtractionArtifact): ExtractionArtifact => {
  const revision = selectRevisionByCommitId(database, input.revision.commitId)
  if (revision === undefined) {
    throw new ExtractionArtifactBindingMismatch({ commitId: input.revision.commitId, reason: "unknownRevision" })
  }
  if (input.artifact.commitId !== revision.commitId) {
    throw new ExtractionArtifactBindingMismatch({ commitId: revision.commitId, reason: "unknownRevision" })
  }
  if (input.artifact.sourceDigest !== revision.sourceDigest) {
    throw new ExtractionArtifactBindingMismatch({ commitId: revision.commitId, reason: "sourceDigest" })
  }
  if (input.artifact.extractionGeneration !== revision.extractionGeneration) {
    throw new ExtractionArtifactBindingMismatch({ commitId: revision.commitId, reason: "extractionGeneration" })
  }
  const parsed = parseExtractionArtifact(input.artifact.id, input.artifact.canonicalJson)
  if (parsed._tag === "Failure") throw parsed.failure
  const existing = selectExtractionArtifact(database, revision)
  if (existing !== undefined) {
    if (existing.canonicalJson !== parsed.success.canonicalJson) {
      throw new ExtractionArtifactConflict({ commitId: revision.commitId })
    }
    return existing
  }
  if (revision.state === "RECEIVED" || revision.state === "COMMITTED") {
    throw new ExtractionArtifactStateInvalid({ commitId: revision.commitId, state: revision.state })
  }
  database
    .prepare(
      `INSERT INTO extraction_artifacts (commit_id, artifact_id, canonical_json, created_at_ms)
       VALUES (?, ?, ?, ?)`
    )
    .run(revision.commitId, parsed.success.id, parsed.success.canonicalJson, Date.now())
  const stored = selectExtractionArtifact(database, revision)
  if (stored === undefined) throw new Error("inserted extraction artifact was not readable")
  return stored
}

export const createArtifactOperations = (database: DatabaseSync): ArtifactOperations => ({
  storeExtractionArtifact: (input) =>
    Effect.try({
      try: () => transaction(database, () => storeArtifact(database, input)),
      catch: (cause) =>
        cause instanceof InvalidExtractionArtifact ||
        cause instanceof ExtractionArtifactBindingMismatch ||
        cause instanceof ExtractionArtifactStateInvalid ||
        cause instanceof ExtractionArtifactConflict
          ? cause
          : new IngestManifestUnavailable({ operation: "storeExtractionArtifact", cause })
    }),

  readExtractionArtifact: (revision) =>
    Effect.try({
      try: () => selectExtractionArtifact(database, revision) ?? null,
      catch: (cause) => new IngestManifestUnavailable({ operation: "readExtractionArtifact", cause })
    })
})
