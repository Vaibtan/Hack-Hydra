import type { DatabaseSync } from "node:sqlite"
import { Effect, Result, Schema } from "effect"
import { canonicalJson, type CanonicalJson } from "../SourceIdentity.js"
import { selectRevisionByCommitId, text, transaction } from "./Rows.js"
import {
  IngestManifestUnavailable,
  InvalidSupersessionDecisions,
  SupersessionDecisionConflict,
  type SourceRevision,
  type StoreSupersessionDecisions,
  type SupersessionDecisionLink,
  type SupersessionDecisions
} from "./Types.js"

export interface EnrichmentOperations {
  /**
   * Persist the supersession edges decided while enriching one revision.
   * Written once per revision during INDEXED -> ENRICHED; storing an identical
   * link set is idempotent and a divergent re-write conflicts so resumed work
   * can never silently drift from what was decided.
   */
  readonly storeSupersessionDecisions: (
    input: StoreSupersessionDecisions
  ) => Effect.Effect<
    SupersessionDecisions,
    | InvalidSupersessionDecisions
    | SupersessionDecisionConflict
    | IngestManifestUnavailable
  >
  /** Read the durable supersession record for one revision, or null when enrichment has not run. */
  readonly readSupersessionDecisions: (
    revision: SourceRevision
  ) => Effect.Effect<SupersessionDecisions | null, IngestManifestUnavailable>
}

const DECISIONS_FORMAT = "palimpsest.supersession-decisions.v1"
/** `claimDigest` is a lowercase SHA-1 hex string. */
const CLAIM_DIGEST = /^[a-f0-9]{40}$/

const DecisionsSchema = Schema.Struct({
  format: Schema.Literal(DECISIONS_FORMAT),
  commit_id: Schema.String,
  links: Schema.Array(
    Schema.Struct({
      older_commit_id: Schema.String,
      older_claim_digest: Schema.String,
      newer_commit_id: Schema.String,
      newer_claim_digest: Schema.String
    })
  )
})

const linkKey = (link: SupersessionDecisionLink): string =>
  `${link.older.commitId}${link.older.claimDigest}${link.newer.commitId}${link.newer.claimDigest}`

const encodeDecisions = (decisions: SupersessionDecisions): string =>
  canonicalJson({
    format: DECISIONS_FORMAT,
    commit_id: decisions.commitId,
    links: decisions.links.map(
      (link): CanonicalJson => ({
        older_commit_id: link.older.commitId,
        older_claim_digest: link.older.claimDigest,
        newer_commit_id: link.newer.commitId,
        newer_claim_digest: link.newer.claimDigest
      })
    )
  })

const decodeDecisions = (serialized: string): SupersessionDecisions => {
  const decoded = Schema.decodeUnknownResult(DecisionsSchema)(JSON.parse(serialized))
  if (Result.isFailure(decoded)) throw new Error("stored supersession decisions were invalid")
  return {
    commitId: decoded.success.commit_id,
    links: decoded.success.links.map((link) => ({
      older: { commitId: link.older_commit_id, claimDigest: link.older_claim_digest },
      newer: { commitId: link.newer_commit_id, claimDigest: link.newer_claim_digest }
    }))
  }
}

const invalid = (commitId: string, reason: string): never => {
  throw new InvalidSupersessionDecisions({ commitId, reason })
}

const normalizedLinks = (
  database: DatabaseSync,
  revision: SourceRevision,
  links: ReadonlyArray<SupersessionDecisionLink>
): ReadonlyArray<SupersessionDecisionLink> => {
  const seen = new Set<string>()
  const normalized: Array<SupersessionDecisionLink> = []
  for (const link of links) {
    for (const endpoint of [link.older, link.newer]) {
      if (endpoint.commitId.trim().length === 0) {
        return invalid(revision.commitId, "link endpoint commit id must not be empty")
      }
      if (!CLAIM_DIGEST.test(endpoint.claimDigest)) {
        return invalid(
          revision.commitId,
          "link endpoint claim digest must be a lowercase claim digest"
        )
      }
      const target = selectRevisionByCommitId(database, endpoint.commitId)
      if (target === undefined) {
        return invalid(
          revision.commitId,
          `link endpoint ${endpoint.commitId} is an unknown revision`
        )
      }
      if (target.tenant !== revision.tenant || target.uid !== revision.uid) {
        return invalid(
          revision.commitId,
          `link endpoint ${endpoint.commitId} is outside the revision scope`
        )
      }
    }
    if (
      link.older.commitId === link.newer.commitId &&
      link.older.claimDigest === link.newer.claimDigest
    ) {
      return invalid(revision.commitId, "link must name two distinct claims")
    }
    const key = linkKey(link)
    if (!seen.has(key)) {
      seen.add(key)
      normalized.push(link)
    }
  }
  return normalized.sort((left, right) => linkKey(left).localeCompare(linkKey(right)))
}

const selectDecisions = (
  database: DatabaseSync,
  commitId: string
): SupersessionDecisions | undefined => {
  const row = database
    .prepare(`SELECT canonical_json, created_at_ms FROM supersession_decisions WHERE commit_id = ?`)
    .get(commitId)
  if (row === undefined) return undefined
  const decisions = decodeDecisions(text(row, "canonical_json"))
  if (decisions.commitId !== commitId) {
    throw new Error(`stored supersession decisions ${commitId} had an invalid revision binding`)
  }
  return decisions
}

const store = (database: DatabaseSync, input: StoreSupersessionDecisions): SupersessionDecisions => {
  const revision = selectRevisionByCommitId(database, input.revision.commitId)
  if (revision === undefined) {
    return invalid(input.revision.commitId, "does not name a stored source revision")
  }
  const links = normalizedLinks(database, revision, input.links)
  const decisions: SupersessionDecisions = { commitId: revision.commitId, links }
  const existing = selectDecisions(database, revision.commitId)
  if (existing !== undefined) {
    if (encodeDecisions(existing) !== encodeDecisions(decisions)) {
      throw new SupersessionDecisionConflict({ commitId: revision.commitId })
    }
    return existing
  }
  database
    .prepare(
      `INSERT INTO supersession_decisions (commit_id, canonical_json, created_at_ms)
       VALUES (?, ?, ?)`
    )
    .run(revision.commitId, encodeDecisions(decisions), Date.now())
  const stored = selectDecisions(database, revision.commitId)
  if (stored === undefined) throw new Error("inserted supersession decisions were not readable")
  return stored
}

export const createEnrichmentOperations = (database: DatabaseSync): EnrichmentOperations => ({
  storeSupersessionDecisions: (input) =>
    Effect.try({
      try: () => transaction(database, () => store(database, input)),
      catch: (cause) =>
        cause instanceof InvalidSupersessionDecisions || cause instanceof SupersessionDecisionConflict
          ? cause
          : new IngestManifestUnavailable({ operation: "storeSupersessionDecisions", cause })
    }),

  readSupersessionDecisions: (revision) =>
    Effect.try({
      try: () => selectDecisions(database, revision.commitId) ?? null,
      catch: (cause) => new IngestManifestUnavailable({ operation: "readSupersessionDecisions", cause })
    })
})
