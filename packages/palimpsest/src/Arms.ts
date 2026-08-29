import type { ReachedClaim } from "./Scoring.js"

/**
 * Several deterministic ways to reach a claim, unioned into one candidate set.
 *
 * v1 had one arm — the convergence walk — and one widening lever, the slot
 * expansion behind it. That shape loses a question whose second fact nothing
 * lexical reaches: "how many years older is my grandma" converges hard on the
 * grandma claim and never touches `(me, age)`, which is one indexed read away.
 *
 * So candidates come from arms that ask different questions of the same graph,
 * and the union records *which* arm reached each claim. That provenance is not
 * decoration: it is what the union cap sorts by, what the receipt shows, and
 * what the error-class table needs to say whether a miss was retrieval's or
 * selection's.
 */

/**
 * The kinds of arm, in the order the union cap prefers them.
 *
 * A probe hit is an `(entity, attribute)` the question named outright, so it is
 * the most direct evidence there is. A sub-question walk asked something the
 * question actually contains. The convergence walk is the general case.
 * Discovery guessed, from terms the first walk turned up. A slot-mate was not
 * reached by anything — it came along because a candidate filled its slot — and
 * v1 already treats it that way.
 */
export const ARM_PRIORITY = ["probe", "subQuestion", "convergence", "discovery", "slotMate"] as const

export type ArmKind = (typeof ARM_PRIORITY)[number]

export interface ArmResult {
  readonly kind: ArmKind
  /** The arm's own label, e.g. `convergence` or `probe:me|age`, for the receipt. */
  readonly label: string
  readonly claims: ReadonlyArray<ReachedClaim>
}

export interface Candidate extends ReachedClaim {
  /** Every arm that reached this claim, in the order the arms were declared. */
  readonly arms: ReadonlyArray<string>
  /** The best (lowest-index) arm kind that reached it. */
  readonly kind: ArmKind
}

/**
 * How many claims survive the union.
 *
 * The selector reads this table, so it is a prompt budget rather than a recall
 * one: 120 rows of id, index text, date, speaker and status is a few thousand
 * tokens, and past that the listwise call starts losing rows in the middle.
 */
export const UNION_CAP = 120

export interface UnionReport {
  readonly candidates: ReadonlyArray<Candidate>
  /** Claims the cap removed, most-preferred first, for the receipt. */
  readonly dropped: ReadonlyArray<Candidate>
  /** Per-arm counts after the as-of cut, before the union cap. */
  readonly counts: Readonly<Record<string, number>>
}

const priorityOf = (kind: ArmKind): number => ARM_PRIORITY.indexOf(kind)

/**
 * Unions the arms by claim key.
 *
 * **The as-of cut happens here, before any cap** — every arm's claims are
 * filtered to `session_ord ≤ k` first. v1 got this wrong in one place: Query
 * 2's slot-mates were cut to 40 *before* `applyAsOf`, so post-`k` claims
 * consumed the budget and were then discarded, and the scrubber lost recall at
 * every position but the last. v1 is left as it is so the paired comparison is
 * against the shipped behaviour; this is the version that does not.
 *
 * A claim several arms reached keeps the best of each: the lowest arm
 * priority, the highest convergence and score, the shortest path. A probe hit
 * that the convergence walk also found is still a probe hit, and still carries
 * the convergence that walk measured.
 */
export const unionArms = (
  arms: ReadonlyArray<ArmResult>,
  options: { readonly asOf?: number; readonly cap?: number } = {}
): UnionReport => {
  const cap = options.cap ?? UNION_CAP
  const merged = new Map<string, Candidate>()
  const counts: Record<string, number> = {}

  for (const arm of arms) {
    const visible =
      options.asOf === undefined
        ? arm.claims
        : arm.claims.filter((claim) => claim.sessionOrd <= options.asOf!)
    counts[arm.label] = (counts[arm.label] ?? 0) + visible.length

    for (const claim of visible) {
      const existing = merged.get(claim.ckey)
      if (existing === undefined) {
        merged.set(claim.ckey, { ...claim, arms: [arm.label], kind: arm.kind })
        continue
      }
      merged.set(claim.ckey, {
        ...existing,
        anchors: existing.anchors.length >= claim.anchors.length ? existing.anchors : claim.anchors,
        convergence: Math.max(existing.convergence, claim.convergence),
        score: Math.max(existing.score, claim.score),
        hops: Math.min(existing.hops, claim.hops),
        arms: existing.arms.includes(arm.label) ? existing.arms : [...existing.arms, arm.label],
        kind: priorityOf(arm.kind) < priorityOf(existing.kind) ? arm.kind : existing.kind
      })
    }
  }

  const ordered = [...merged.values()].sort(
    (a, b) =>
      priorityOf(a.kind) - priorityOf(b.kind) ||
      b.convergence - a.convergence ||
      b.score - a.score ||
      b.tEvent - a.tEvent ||
      a.ckey.localeCompare(b.ckey)
  )

  return {
    candidates: ordered.slice(0, cap),
    dropped: ordered.slice(cap),
    counts
  }
}
