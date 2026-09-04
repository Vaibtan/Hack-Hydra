import type { ClaimFields, ReachedRow } from "./Rows.js"

export interface ReachedClaim extends ClaimFields {
  readonly anchors: ReadonlyArray<string>
  readonly convergence: number
  /** Σ idf over those anchors. */
  readonly score: number
  /** Shortest path length that reached it: 1 direct, 2 through an Entity. */
  readonly hops: number
}

export const idf = (df: number, totalClaims: number): number =>
  Math.log(1 + totalClaims / Math.max(1, df))

export const scoreReached = (
  rows: ReadonlyArray<ReachedRow>,
  totalClaims: number
): ReadonlyArray<ReachedClaim> => {
  const byClaim = new Map<
    string,
    { claim: ClaimFields; anchors: Map<string, number>; hops: number }
  >()

  for (const row of rows) {
    const existing = byClaim.get(row.claim.ckey)
    if (existing === undefined) {
      byClaim.set(row.claim.ckey, {
        claim: row.claim,
        anchors: new Map([[row.anchor, row.df]]),
        hops: row.hops
      })
    } else {
      if (!existing.anchors.has(row.anchor)) existing.anchors.set(row.anchor, row.df)
      if (row.hops < existing.hops) existing.hops = row.hops
    }
  }

  return [...byClaim.values()].map(({ claim, anchors, hops }) => ({
    ...claim,
    anchors: [...anchors.keys()].sort(),
    convergence: anchors.size,
    score: [...anchors.values()].reduce((sum, df) => sum + idf(df, totalClaims), 0),
    hops
  }))
}

export const beforeAsOf = <A extends { readonly sessionOrd: number }>(
  claims: ReadonlyArray<A>,
  asOf?: number
): ReadonlyArray<A> =>
  asOf === undefined ? claims : claims.filter((claim) => claim.sessionOrd <= asOf)

/** `A1`/`A2` are structural; the other two are the pack's. The reader's `NOT_IN_MEMORY` is an answer, not a verdict. */
export type AbstentionReason =
  | "A1_no_anchors"
  | "A2_no_convergence"
  | "INSUFFICIENT_EVIDENCE"
  | "CONTRADICTED_PREMISE"

export interface Verdict {
  readonly kind: "ANSWER" | "ABSENT"
  readonly reason: AbstentionReason | null
  readonly threshold: number
  readonly candidates: ReadonlyArray<ReachedClaim>
}

/** Two distinct anchors, or every anchor there was when the question produced only one. */
export const convergenceThreshold = (resolvedAnchors: number): number =>
  Math.min(2, Math.max(1, resolvedAnchors))

export const DEFAULT_TOP_K = 25

export const decide = (
  reached: ReadonlyArray<ReachedClaim>,
  resolvedAnchors: number,
  topK = DEFAULT_TOP_K
): Verdict => {
  const threshold = convergenceThreshold(resolvedAnchors)
  if (resolvedAnchors === 0) {
    return { kind: "ABSENT", reason: "A1_no_anchors", threshold, candidates: [] }
  }
  const converged = reached.filter((claim) => claim.convergence >= threshold)
  if (converged.length === 0) {
    return { kind: "ABSENT", reason: "A2_no_convergence", threshold, candidates: [] }
  }
  return { kind: "ANSWER", reason: null, threshold, candidates: rank(converged).slice(0, topK) }
}

export const rank = (claims: ReadonlyArray<ReachedClaim>): ReadonlyArray<ReachedClaim> =>
  [...claims].sort(
    (a, b) =>
      b.convergence - a.convergence ||
      b.score - a.score ||
      b.tEvent - a.tEvent ||
      b.sessionOrd - a.sessionOrd ||
      a.ckey.localeCompare(b.ckey)
  )

export interface AsOfLabelled extends ReachedClaim {
  readonly status: "CURRENT" | "SUPERSEDED"
  readonly supersededBy: string | null
  readonly atSession: number | null
}

export const applyAsOf = (
  claims: ReadonlyArray<ReachedClaim>,
  edges: ReadonlyMap<string, { readonly newer: string; readonly atSession: number }>,
  asOf?: number
): ReadonlyArray<AsOfLabelled> =>
  claims
    .filter((claim) => asOf === undefined || claim.sessionOrd <= asOf)
    .map((claim) => {
      const edge = edges.get(claim.ckey)
      const visible = edge !== undefined && (asOf === undefined || edge.atSession <= asOf)
      return {
        ...claim,
        status: visible ? ("SUPERSEDED" as const) : ("CURRENT" as const),
        supersededBy: visible ? edge!.newer : null,
        atSession: visible ? edge!.atSession : null
      }
    })

/** CURRENT before SUPERSEDED unless the question is historical; within a group, event time ascending with unknown dates last. */
export const orderEvidence = (
  claims: ReadonlyArray<AsOfLabelled>,
  historical: boolean
): ReadonlyArray<AsOfLabelled> =>
  [...claims].sort((a, b) => {
    if (!historical && a.status !== b.status) return a.status === "CURRENT" ? -1 : 1
    const aTime = a.tEvent === 0 ? Number.MAX_SAFE_INTEGER : a.tEvent
    const bTime = b.tEvent === 0 ? Number.MAX_SAFE_INTEGER : b.tEvent
    return aTime - bTime || a.sessionOrd - b.sessionOrd || a.ckey.localeCompare(b.ckey)
  })
