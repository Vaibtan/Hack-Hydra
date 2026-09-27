import type { MemoryNode, MemoryPath } from "@palimpsest/hydra"
import { createHash } from "node:crypto"
import { Result } from "effect"
import {
  SnapshotGraphMismatch,
  SnapshotScopeViolation,
  type ClaimProvenance,
  type QueryContext
} from "./QueryContext.js"
import type { ClaimFields } from "./Rows.js"
import { scopePrefix } from "./MemoryScope.js"
import { snapshotRootKey } from "./SnapshotGraph.js"

type PathNode = MemoryPath["nodes"][number]

const str = (node: PathNode | undefined, key: string): string =>
  node === undefined ? "" : String(node.properties[key] ?? "")

const num = (node: PathNode | undefined, key: string): number =>
  node === undefined ? 0 : Number(node.properties[key] ?? 0)

/** The key namespace every vertex of the bound snapshot lives under. */
export const snapshotNamespacePrefix = (query: QueryContext): string =>
  `${snapshotRootKey(query.scope, query.snapshot.id)}|`

/** Short, stable citation id for a snapshot claim key (12 hex chars of its hash). */
export const snapshotShortId = (ckey: string): string =>
  createHash("sha256").update(ckey, "utf8").digest("hex").slice(0, 12)

const checkSnapshotKey = (
  query: QueryContext,
  key: string
): Result.Result<never, SnapshotScopeViolation> => {
  if (!key.startsWith(snapshotNamespacePrefix(query))) {
    return Result.fail(
      new SnapshotScopeViolation({
        expectedSnapshotId: query.snapshot.id,
        key,
        reason: key.startsWith(`${scopePrefix(query.scope)}|`) ? "foreignSnapshot" : "foreignScope"
      })
    )
  }
  // SAFETY: the success case carries no value by design; callers only propagate the failure.
  return Result.succeed(undefined as never)
}

const checkCoveredCommit = (
  query: QueryContext,
  commitId: string,
  key: string
): Result.Result<never, SnapshotGraphMismatch> => {
  if (!query.snapshot.sourceCommitIds.includes(commitId)) {
    return Result.fail(
      new SnapshotGraphMismatch({
        snapshotId: query.snapshot.id,
        reason: "uncoveredRevision",
        detail: `${commitId} for ${key}`
      })
    )
  }
  // SAFETY: the success case carries no value by design; callers only propagate the failure.
  return Result.succeed(undefined as never)
}

export interface SnapshotClaimFields extends ClaimFields {
  readonly id: string
  readonly acceptedAtMs: number
  readonly provenance: ClaimProvenance
}

export interface SnapshotReachedRow {
  readonly anchor: string
  readonly df: number
  readonly hops: number
  readonly claim: SnapshotClaimFields
}

/**
 * Snapshot `Token -HITS|NAMES|MENTIONS-> Claim` rows. Empty claim keys are
 * skipped like the legacy parser; any key outside the bound snapshot fails
 * the read instead of leaking across snapshots.
 */
export const snapshotReachedRows = (
  paths: ReadonlyArray<MemoryPath>,
  query: QueryContext
): Result.Result<ReadonlyArray<SnapshotReachedRow>, SnapshotScopeViolation | SnapshotGraphMismatch> => {
  const rows: Array<SnapshotReachedRow> = []
  for (const path of paths) {
    const source = path.nodes[0]
    const target = path.nodes[path.nodes.length - 1]
    if (source === undefined || target === undefined || source === target) continue
    const ckey = str(target, "snapshot_claim")
    if (ckey === "") continue
    const checked = checkSnapshotKey(query, ckey)
    if (Result.isFailure(checked)) return checked
    const commitId = str(target, "commit_id")
    const covered = checkCoveredCommit(query, commitId, ckey)
    if (Result.isFailure(covered)) return covered
    const logicalSessionId = str(target, "logical_session_id")
    rows.push({
      anchor: str(source, "token") || str(source, "snapshot_token"),
      df: num(source, "df"),
      hops: path.relationships.length,
      claim: {
        ckey,
        text: str(target, "text"),
        speaker: str(target, "speaker"),
        ctype: str(target, "ctype"),
        sessionOrd: num(target, "session_ord"),
        sessionDate: num(target, "session_date"),
        acceptedAtMs: num(target, "accepted_at_ms"),
        tEvent: num(target, "t_event"),
        tPrec: str(target, "t_prec"),
        sid: str(target, "sid"),
        sessionKey: logicalSessionId,
        turnIdx: num(target, "turn_idx"),
        cs: num(target, "cs"),
        ce: num(target, "ce"),
        id: snapshotShortId(ckey),
        provenance: {
          snapshotId: query.snapshot.id,
          commitId,
          sourceDigest: str(target, "source_digest"),
          logicalSessionId,
          indexGenerationId: query.snapshot.indexGenerationId,
          canonicalViewId: query.snapshot.canonicalViewId
        }
      }
    })
  }
  return Result.succeed(rows)
}

/** One `SNAPSHOT_FILLS` path in either direction. `ckey` may be empty; `skey` never is. */
export interface SnapshotSlotFill {
  readonly skey: string
  readonly ckey: string
}

export const snapshotSlotFills = (
  paths: ReadonlyArray<MemoryPath>,
  query: QueryContext
): Result.Result<ReadonlyArray<SnapshotSlotFill>, SnapshotScopeViolation> => {
  const fills: Array<SnapshotSlotFill> = []
  for (const path of paths) {
    const head = path.nodes[0]
    const tail = path.nodes[path.nodes.length - 1]
    const skey = str(head, "snapshot_slot") || str(tail, "snapshot_slot")
    if (skey === "") continue
    const checkedSlot = checkSnapshotKey(query, skey)
    if (Result.isFailure(checkedSlot)) return checkedSlot
    const ckey = str(head, "snapshot_claim") || str(tail, "snapshot_claim")
    if (ckey !== "") {
      const checkedClaim = checkSnapshotKey(query, ckey)
      if (Result.isFailure(checkedClaim)) return checkedClaim
    }
    fills.push({ skey, ckey })
  }
  return Result.succeed(fills)
}

/** A `SnapshotClaim -SNAPSHOT_EVIDENCE-> SnapshotEvidence` locator. */
export interface SnapshotEvidenceLocator {
  readonly ckey: string
  readonly commitId: string
  readonly logicalSessionId: string
  readonly sourceDigest: string
  readonly turnIdx: number
  readonly sourceTurnKey: string
}

export const snapshotEvidenceLocators = (
  paths: ReadonlyArray<MemoryPath>,
  query: QueryContext
): Result.Result<
  ReadonlyArray<SnapshotEvidenceLocator>,
  SnapshotScopeViolation | SnapshotGraphMismatch
> => {
  const locators: Array<SnapshotEvidenceLocator> = []
  for (const path of paths) {
    const claim = path.nodes[0]
    const evidence = path.nodes[path.nodes.length - 1]
    if (claim === undefined || evidence === undefined || claim === evidence) continue
    const ckey = str(claim, "snapshot_claim")
    const evidenceKey = str(evidence, "snapshot_evidence")
    if (ckey === "" || evidenceKey === "") continue
    const checkedClaim = checkSnapshotKey(query, ckey)
    if (Result.isFailure(checkedClaim)) return checkedClaim
    const checkedEvidence = checkSnapshotKey(query, evidenceKey)
    if (Result.isFailure(checkedEvidence)) return checkedEvidence
    const commitId = str(evidence, "commit_id")
    const covered = checkCoveredCommit(query, commitId, ckey)
    if (Result.isFailure(covered)) return covered
    const sourceTurnKey = str(evidence, "source_turn_key")
    if (!sourceTurnKey.startsWith(`${scopePrefix(query.scope)}|`)) {
      return Result.fail(
        new SnapshotScopeViolation({
          expectedSnapshotId: query.snapshot.id,
          key: sourceTurnKey === "" ? ckey : sourceTurnKey,
          reason: "foreignScope"
        })
      )
    }
    locators.push({
      ckey,
      commitId,
      logicalSessionId: str(evidence, "logical_session_id"),
      sourceDigest: str(evidence, "source_digest"),
      turnIdx: num(evidence, "turn_idx"),
      sourceTurnKey
    })
  }
  return Result.succeed(locators)
}

/**
 * Snapshot `SNAPSHOT_SUPERSEDED_BY` winner map. Same earliest-wins fold as the
 * legacy parser, with every key validated against the bound snapshot.
 */
export const snapshotSupersedeFold = (
  paths: ReadonlyArray<MemoryPath>,
  query: QueryContext,
  asOf?: number
): Result.Result<
  ReadonlyMap<string, { readonly newer: string; readonly atSession: number }>,
  SnapshotScopeViolation
> => {
  const byOlder = new Map<string, { newer: string; atSession: number }>()
  for (const path of paths) {
    const older = path.nodes[0]
    const newer = path.nodes[path.nodes.length - 1]
    const edge = path.relationships[0]
    if (older === undefined || newer === undefined || edge === undefined) continue
    const atSession = Number(edge.properties["at_session"] ?? 0)
    if (asOf !== undefined && atSession > asOf) continue
    const olderCkey = str(older, "snapshot_claim")
    const newerCkey = str(newer, "snapshot_claim")
    if (olderCkey === "" || newerCkey === "") continue
    const checkedOlder = checkSnapshotKey(query, olderCkey)
    if (Result.isFailure(checkedOlder)) return checkedOlder
    const checkedNewer = checkSnapshotKey(query, newerCkey)
    if (Result.isFailure(checkedNewer)) return checkedNewer
    const existing = byOlder.get(olderCkey)
    if (
      existing !== undefined &&
      (existing.atSession < atSession ||
        (existing.atSession === atSession && existing.newer <= newerCkey))
    ) {
      continue
    }
    byOlder.set(olderCkey, { newer: newerCkey, atSession })
  }
  return Result.succeed(byOlder)
}

/** Probe index key: JSON framing keeps canons containing separators unambiguous. */
export const snapshotSlotIndexKey = (entityCanon: string, attr: string): string =>
  JSON.stringify([entityCanon, attr])

/** `(entityCanon, attr)` probe lookup over one `SNAPSHOT_HAS_SLOT` walk. */
export const snapshotSlotIndex = (
  paths: ReadonlyArray<MemoryPath>,
  query: QueryContext
): Result.Result<ReadonlyMap<string, string>, SnapshotScopeViolation> => {
  const index = new Map<string, string>()
  for (const path of paths) {
    const slot = path.nodes[path.nodes.length - 1]
    const key = str(slot, "snapshot_slot")
    if (key === "") continue
    const checked = checkSnapshotKey(query, key)
    if (Result.isFailure(checked)) return checked
    index.set(snapshotSlotIndexKey(str(slot, "entity_canon"), str(slot, "attr")), key)
  }
  return Result.succeed(index)
}

export interface SnapshotSourceTurn {
  readonly key: string
  readonly text: string
  readonly chunks: number
  readonly role: string
  readonly turnIdx: number
}

/** Validate one directly-read `SourceTurn` node against the locator that named it. */
export const parseSnapshotSourceTurn = (
  key: string,
  node: MemoryNode,
  query: QueryContext,
  expected: { readonly logicalSessionId: string; readonly sourceDigest: string }
): Result.Result<SnapshotSourceTurn, SnapshotGraphMismatch> => {
  const properties = node.properties
  const mismatch = (detail: string): Result.Result<never, SnapshotGraphMismatch> =>
    Result.fail(
      new SnapshotGraphMismatch({
        snapshotId: query.snapshot.id,
        reason: "sourceTurnMismatch",
        detail: `${key}: ${detail}`
      })
    )
  if (String(properties["tenant"] ?? "") !== query.scope.tenantId) return mismatch("tenant")
  if (String(properties["uid"] ?? "") !== query.scope.uid) return mismatch("uid")
  if (String(properties["logical_session_id"] ?? "") !== expected.logicalSessionId) {
    return mismatch("logical_session_id")
  }
  if (String(properties["source_digest"] ?? "") !== expected.sourceDigest) {
    return mismatch("source_digest")
  }
  return Result.succeed({
    key,
    text: String(properties["text"] ?? ""),
    chunks: Number(properties["chunks"] ?? 0),
    role: String(properties["role"] ?? ""),
    turnIdx: Number(properties["turn_idx"] ?? 0)
  })
}

/** Fail closed unless every candidate carries the bound snapshot's provenance, generation, and view. */
export const requireSnapshotProvenance = <C extends { readonly ckey: string; readonly provenance?: ClaimProvenance }>(
  candidates: ReadonlyArray<C>,
  query: QueryContext
): Result.Result<ReadonlyArray<C>, SnapshotScopeViolation> => {
  for (const candidate of candidates) {
    const provenance = candidate.provenance
    if (provenance === undefined) {
      return Result.fail(
        new SnapshotScopeViolation({
          expectedSnapshotId: query.snapshot.id,
          key: candidate.ckey,
          reason: "missingProvenance"
        })
      )
    }
    if (
      provenance.snapshotId !== query.snapshot.id ||
      provenance.indexGenerationId !== query.snapshot.indexGenerationId ||
      provenance.canonicalViewId !== query.snapshot.canonicalViewId
    ) {
      return Result.fail(
        new SnapshotScopeViolation({
          expectedSnapshotId: query.snapshot.id,
          key: candidate.ckey,
          reason: "foreignSnapshot"
        })
      )
    }
  }
  return Result.succeed(candidates)
}
