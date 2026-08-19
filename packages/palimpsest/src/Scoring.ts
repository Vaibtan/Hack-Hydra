import type { HydraPath } from "@palimpsest/hydra"

/**
 * Convergence scoring and the structural verdict.
 *
 * Everything here is a pure function of the paths HydraDB returned, so the
 * decision to answer or abstain is reproducible from the receipt alone and can
 * be unit-tested without a database. That is the point: the claim is not that
 * no threshold exists anywhere, it is that the threshold is one named number,
 * printed in the receipt, applied to a structural quantity anyone can re-derive.
 */

export interface ReachedClaim {
  readonly ckey: string
  readonly text: string
  readonly speaker: string
  readonly ctype: string
  readonly sessionOrd: number
  readonly sessionDate: number
  readonly tEvent: number
  readonly tPrec: string
  readonly sid: string
  readonly turnIdx: number
  readonly cs: number
  readonly ce: number
  /** The distinct question anchors that reached this claim. */
  readonly anchors: ReadonlyArray<string>
  /** How many of them — the convergence score. */
  readonly convergence: number
  /** Σ idf over those anchors. Breaks ties between equally-converged claims. */
  readonly score: number
  /** Shortest path length that reached it: 1 direct, 2 through an Entity. */
  readonly hops: number
}

/**
 * Rare anchors say more than common ones. `df` is the number of claims a token
 * hits within this user's graph, so a token on every claim contributes almost
 * nothing and a token on two claims contributes a lot.
 */
export const idf = (df: number, totalClaims: number): number =>
  Math.log(1 + totalClaims / Math.max(1, df))

const propString = (node: HydraPath["nodes"][number] | undefined, key: string): string =>
  node === undefined ? "" : String(node.properties[key] ?? "")

const propNumber = (node: HydraPath["nodes"][number] | undefined, key: string): number =>
  node === undefined ? 0 : Number(node.properties[key] ?? 0)

/**
 * Folds the paths of Query 1 into one row per Claim.
 *
 * A path is Token→Claim or Token→Entity→Claim. The first node is always the
 * anchor the path started from, so convergence is just the number of distinct
 * first nodes that ended at the same last node.
 */
export const scoreReached = (
  paths: ReadonlyArray<HydraPath>,
  totalClaims: number
): ReadonlyArray<ReachedClaim> => {
  const byClaim = new Map<
    string,
    { claim: Omit<ReachedClaim, "anchors" | "convergence" | "score" | "hops">; anchors: Map<string, number>; hops: number }
  >()

  for (const path of paths) {
    const source = path.nodes[0]
    const target = path.nodes[path.nodes.length - 1]
    if (source === undefined || target === undefined || source === target) continue

    const ckey = propString(target, "ckey")
    if (ckey === "") continue
    const stem = propString(source, "stem") || propString(source, "tkey")
    const df = propNumber(source, "df")

    const existing = byClaim.get(ckey)
    const hops = path.relationships.length
    if (existing === undefined) {
      byClaim.set(ckey, {
        claim: {
          ckey,
          text: propString(target, "text"),
          speaker: propString(target, "speaker"),
          ctype: propString(target, "ctype"),
          sessionOrd: propNumber(target, "session_ord"),
          sessionDate: propNumber(target, "session_date"),
          tEvent: propNumber(target, "t_event"),
          tPrec: propString(target, "t_prec"),
          sid: propString(target, "sid"),
          turnIdx: propNumber(target, "turn_idx"),
          cs: propNumber(target, "cs"),
          ce: propNumber(target, "ce")
        },
        anchors: new Map([[stem, df]]),
        hops
      })
    } else {
      if (!existing.anchors.has(stem)) existing.anchors.set(stem, df)
      if (hops < existing.hops) existing.hops = hops
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

/**
 * The as-of cut, applied to the reached claims **before** the verdict.
 *
 * The spec (§3.4) lists as-of as step 5, after the structural verdict and the
 * top-K cut, and that is wrong — see the erratum in the spec. A receipt
 * computed over claims the memory is not supposed to have yet is a receipt that
 * lies at every scrubber position but the last: it reports anchors resolving
 * against future claims, a convergence table of claims that do not exist, and
 * an A1/A2 decision taken on evidence the answer may not use. Worse, top-K is
 * consumed by future claims, so recall degrades for early `k` for no reason
 * anyone could see.
 *
 * The later `applyAsOf` still runs, because it does the other half: supersession
 * edges written after `k` are invisible, and the slot-mates pulled in by Query 2
 * have to be cut too.
 */
export const beforeAsOf = <A extends { readonly sessionOrd: number }>(
  claims: ReadonlyArray<A>,
  asOf?: number
): ReadonlyArray<A> =>
  asOf === undefined ? claims : claims.filter((claim) => claim.sessionOrd <= asOf)

export type AbstentionReason = "A1_no_anchors" | "A2_no_convergence"

export interface Verdict {
  readonly kind: "ANSWER" | "ABSENT"
  readonly reason: AbstentionReason | null
  /** The convergence a claim had to reach. Printed in every receipt. */
  readonly threshold: number
  readonly candidates: ReadonlyArray<ReachedClaim>
}

/**
 * The one tunable in the whole read path: a claim must be reached by at least
 * two distinct anchors, or by every anchor there was when the question only
 * produced one. `min` rather than a flat 2 so a one-word question can still be
 * answered — otherwise "Nibbles?" would abstain by construction.
 */
export const convergenceThreshold = (resolvedAnchors: number): number =>
  Math.min(2, Math.max(1, resolvedAnchors))

export const DEFAULT_TOP_K = 25

/**
 * The structural verdict. `A1` means no anchor of the question exists in this
 * user's graph at all; `A2` means anchors exist but no claim is reached by
 * enough of them. Both are backed by the query and its result, which is what
 * makes the abstention showable rather than asserted.
 */
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

/**
 * Most converged first, then by idf mass, then newest, then by key so the order
 * — and therefore the determinism hash — never depends on map iteration.
 */
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

/**
 * "As of session k" is a filter over data, not a database snapshot: drop claims
 * from later sessions, ignore supersession edges written later, then label what
 * is left. HydraDB bookmarks are causal floors and cannot do this.
 */
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

/**
 * Evidence order. Superseded claims are kept — the reader may need them to
 * answer a historical question — but demoted below current ones unless the
 * question asked about history. Within a group, chronological by event time,
 * with unknown event dates last so date arithmetic reads in order.
 */
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
