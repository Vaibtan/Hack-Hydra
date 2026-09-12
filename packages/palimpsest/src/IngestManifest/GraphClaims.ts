import type { DatabaseSync } from "node:sqlite"
import { vertexId, type NumericIdForKey } from "@palimpsest/hydra"
import { Effect } from "effect"
import { integer, text, transaction, type DatabaseRow } from "./Rows.js"
import {
  GraphIdCollision,
  GraphIdRecoveryRejected,
  IngestManifestUnavailable,
  InvalidGraphIdClaim,
  type ClaimGraphId,
  type CompleteGraphIdRekey,
  type GraphIdClaim,
  type GraphIdClaimDisposition,
  type GraphIdKind,
  type GraphIdQuarantineRecord
} from "./Types.js"

export interface GraphClaimOperations {
  /**
   * Durably claim one reduced graph id for one canonical identity. Must run
   * before the corresponding graph upsert (S01): same id + same identity is
   * idempotent, same id + different identity quarantines and fails instead
   * of merging ambiguous data.
   */
  readonly claimGraphId: (
    input: ClaimGraphId
  ) => Effect.Effect<GraphIdClaimDisposition, GraphIdCollision | InvalidGraphIdClaim | IngestManifestUnavailable>
  readonly readGraphIdClaim: (
    input: Omit<ClaimGraphId, "canonicalIdentity">
  ) => Effect.Effect<GraphIdClaim | null, InvalidGraphIdClaim | IngestManifestUnavailable>
  /** Read one collision quarantine record by reduced id and graph kind. */
  readonly readGraphIdQuarantine: (
    input: Pick<ClaimGraphId, "kind" | "reducedId">
  ) => Effect.Effect<GraphIdQuarantineRecord | null, InvalidGraphIdClaim | IngestManifestUnavailable>
  /** Observable quarantine of detected collisions; cleared only after a rebuild/rekey recovery. */
  readonly listGraphIdQuarantine: () => Effect.Effect<
    ReadonlyArray<GraphIdQuarantineRecord>,
    IngestManifestUnavailable
  >
  readonly completeGraphIdRekey: (
    input: CompleteGraphIdRekey
  ) => Effect.Effect<
    void,
    GraphIdRecoveryRejected | InvalidGraphIdClaim | IngestManifestUnavailable
  >
}

const isKind = (value: unknown): value is GraphIdKind => value === "vertex" || value === "relationship"

const validateClaim = (input: ClaimGraphId, numericIdForKey: NumericIdForKey): void => {
  if (!Number.isSafeInteger(input.reducedId) || input.reducedId < 0) {
    throw new InvalidGraphIdClaim({ field: "reducedId", reason: "must be a non-negative safe integer" })
  }
  if (!isKind(input.kind)) {
    throw new InvalidGraphIdClaim({ field: "kind", reason: "must be vertex or relationship" })
  }
  if (input.canonicalIdentity.trim().length === 0) {
    throw new InvalidGraphIdClaim({ field: "canonicalIdentity", reason: "must not be empty" })
  }
  if (numericIdForKey(input.canonicalIdentity) !== input.reducedId) {
    throw new InvalidGraphIdClaim({
      field: "reducedId",
      reason: "must be derived from the canonical identity"
    })
  }
}

const validateScope = (input: Pick<ClaimGraphId, "kind" | "reducedId">): void => {
  if (!Number.isSafeInteger(input.reducedId) || input.reducedId < 0) {
    throw new InvalidGraphIdClaim({ field: "reducedId", reason: "must be a non-negative safe integer" })
  }
  if (!isKind(input.kind)) {
    throw new InvalidGraphIdClaim({ field: "kind", reason: "must be vertex or relationship" })
  }
}

const decodeClaim = (row: DatabaseRow): GraphIdClaim => ({
  reducedId: integer(row, "reduced_id"),
  kind: text(row, "kind") as GraphIdKind,
  canonicalIdentity: text(row, "canonical_identity"),
  claimedAtMs: integer(row, "claimed_at_ms")
})

const selectClaim = (
  database: DatabaseSync,
  reducedId: number,
  kind: GraphIdKind
): GraphIdClaim | undefined => {
  const row = database
    .prepare(`SELECT reduced_id, kind, canonical_identity, claimed_at_ms FROM graph_id_claims WHERE reduced_id = ? AND kind = ?`)
    .get(reducedId, kind) as DatabaseRow | undefined
  return row === undefined ? undefined : decodeClaim(row)
}

type ClaimOutcome =
  | { readonly _tag: "Claimed" }
  | { readonly _tag: "Idempotent" }
  | {
      readonly _tag: "Collision"
      readonly reducedId: number
      readonly kind: GraphIdKind
      readonly existingIdentity: string
      readonly rejectedIdentity: string
    }

const claim = (
  database: DatabaseSync,
  input: ClaimGraphId,
  numericIdForKey: NumericIdForKey
): ClaimOutcome => {
  validateClaim(input, numericIdForKey)
  const existing = selectClaim(database, input.reducedId, input.kind)
  if (existing !== undefined) {
    if (existing.canonicalIdentity === input.canonicalIdentity) return { _tag: "Idempotent" }
    // Quarantine inside the same committed transaction: detection must never
    // leave ambiguous graph data silently merged, and the record must survive
    // the failure it reports.
    database
      .prepare(
        `INSERT INTO graph_id_quarantine (reduced_id, kind, existing_identity, rejected_identity, detected_at_ms)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(reduced_id, kind) DO NOTHING`
      )
      .run(input.reducedId, input.kind, existing.canonicalIdentity, input.canonicalIdentity, Date.now())
    return {
      _tag: "Collision",
      reducedId: input.reducedId,
      kind: input.kind,
      existingIdentity: existing.canonicalIdentity,
      rejectedIdentity: input.canonicalIdentity
    }
  }
  database
    .prepare(
      `INSERT INTO graph_id_claims (reduced_id, kind, canonical_identity, claimed_at_ms)
       VALUES (?, ?, ?, ?)`
    )
    .run(input.reducedId, input.kind, input.canonicalIdentity, Date.now())
  return { _tag: "Claimed" }
}

const readClaim = (
  database: DatabaseSync,
  input: Omit<ClaimGraphId, "canonicalIdentity">
): GraphIdClaim | null => {
  validateScope(input)
  return selectClaim(database, input.reducedId, input.kind) ?? null
}

const listQuarantine = (database: DatabaseSync): ReadonlyArray<GraphIdQuarantineRecord> => {
  const rows = database
    .prepare(
      `SELECT reduced_id, kind, existing_identity, rejected_identity, detected_at_ms
         FROM graph_id_quarantine ORDER BY detected_at_ms, reduced_id`
    )
    .all() as ReadonlyArray<DatabaseRow>
  return rows.map((row) => ({
    reducedId: integer(row, "reduced_id"),
    kind: text(row, "kind") as GraphIdKind,
    existingIdentity: text(row, "existing_identity"),
    rejectedIdentity: text(row, "rejected_identity"),
    detectedAtMs: integer(row, "detected_at_ms")
  }))
}

const readQuarantine = (
  database: DatabaseSync,
  input: Pick<ClaimGraphId, "kind" | "reducedId">
): GraphIdQuarantineRecord | null => {
  validateScope(input)
  const row = database
    .prepare(
      `SELECT reduced_id, kind, existing_identity, rejected_identity, detected_at_ms
         FROM graph_id_quarantine WHERE reduced_id = ? AND kind = ?`
    )
    .get(input.reducedId, input.kind) as DatabaseRow | undefined
  if (row === undefined) return null
  return {
    reducedId: integer(row, "reduced_id"),
    kind: text(row, "kind") as GraphIdKind,
    existingIdentity: text(row, "existing_identity"),
    rejectedIdentity: text(row, "rejected_identity"),
    detectedAtMs: integer(row, "detected_at_ms")
  }
}

const completeRekey = (
  database: DatabaseSync,
  input: CompleteGraphIdRekey,
  numericIdForKey: NumericIdForKey
): void => {
  validateScope(input)
  validateClaim(
    {
      reducedId: input.replacementReducedId,
      kind: input.kind,
      canonicalIdentity: input.replacementCanonicalIdentity
    },
    numericIdForKey
  )
  if (input.replacementReducedId === input.reducedId) {
    throw new GraphIdRecoveryRejected({ ...input, reason: "sameReducedId" })
  }
  const quarantine = readQuarantine(database, input)
  if (quarantine === null || quarantine.rejectedIdentity !== input.rejectedIdentity) {
    throw new GraphIdRecoveryRejected({ ...input, reason: "missingQuarantine" })
  }
  const replacement = selectClaim(database, input.replacementReducedId, input.kind)
  if (replacement?.canonicalIdentity !== input.replacementCanonicalIdentity) {
    throw new GraphIdRecoveryRejected({ ...input, reason: "replacementClaimMismatch" })
  }
  database
    .prepare(`DELETE FROM graph_id_quarantine WHERE reduced_id = ? AND kind = ?`)
    .run(input.reducedId, input.kind)
}

/** Build durable graph-id claim operations with an injectable reducer for deterministic collision tests. */
export const makeGraphClaimOperations = (
  database: DatabaseSync,
  numericIdForKey: NumericIdForKey = vertexId
): GraphClaimOperations => ({
  claimGraphId: (input) =>
    Effect.try({
      try: () => {
        // The collision is thrown only after its transaction commits, so the
        // quarantine record survives the failure it reports.
        const outcome = transaction(database, () => claim(database, input, numericIdForKey))
        switch (outcome._tag) {
          case "Claimed":
            return "claimed" as const
          case "Idempotent":
            return "idempotent" as const
          case "Collision":
            throw new GraphIdCollision({
              reducedId: outcome.reducedId,
              kind: outcome.kind,
              existingIdentity: outcome.existingIdentity,
              rejectedIdentity: outcome.rejectedIdentity
            })
        }
      },
      catch: (cause) =>
        cause instanceof GraphIdCollision || cause instanceof InvalidGraphIdClaim
          ? cause
          : new IngestManifestUnavailable({ operation: "claimGraphId", cause })
    }),

  readGraphIdClaim: (input) =>
    Effect.try({
      try: () => readClaim(database, input),
      catch: (cause) =>
        cause instanceof InvalidGraphIdClaim
          ? cause
          : new IngestManifestUnavailable({ operation: "readGraphIdClaim", cause })
    }),

  readGraphIdQuarantine: (input) =>
    Effect.try({
      try: () => readQuarantine(database, input),
      catch: (cause) =>
        cause instanceof InvalidGraphIdClaim
          ? cause
          : new IngestManifestUnavailable({ operation: "readGraphIdQuarantine", cause })
    }),

  listGraphIdQuarantine: () =>
    Effect.try({
      try: () => listQuarantine(database),
      catch: (cause) => new IngestManifestUnavailable({ operation: "listGraphIdQuarantine", cause })
    }),

  completeGraphIdRekey: (input) =>
    Effect.try({
      try: () => transaction(database, () => completeRekey(database, input, numericIdForKey)),
      catch: (cause) =>
        cause instanceof GraphIdRecoveryRejected || cause instanceof InvalidGraphIdClaim
          ? cause
          : new IngestManifestUnavailable({ operation: "completeGraphIdRekey", cause })
    })
})
