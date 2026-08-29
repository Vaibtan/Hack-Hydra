import {
  HydraClient,
  renderMsPathsQuery,
  type HydraError,
  type HydraPath,
  type MsPathsConfig
} from "@palimpsest/hydra"
import { Effect } from "effect"
import { claimKind, slotKey, tokenKey } from "./Keys.js"
import { scoreReached, type ReachedClaim } from "./Scoring.js"
import { stems } from "./Tokenize.js"
import type { Probe, SubQuestion } from "./Understand.js"

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

// ------------------------------------------------------------ the live arms

/**
 * Query 1's shape, shared by every arm that walks from anchors.
 *
 * A constant-valued target selector (`Claim.kind`) is what makes an `MSpaths`
 * walk return *every* source→target pair rather than one path per source, and
 * it is also an order of magnitude faster than raising `pathCount` — see the
 * engine table in CONTEXT.md. Every arm below reuses it, so a sub-question walk
 * costs exactly what the primary walk costs.
 */
export const convergenceConfig = (
  uid: string,
  terms: ReadonlyArray<string>,
  maxLen: number
): MsPathsConfig => ({
  sourceLabel: "Token",
  sourceProperty: "tkey",
  sourceValues: terms.map((stem) => tokenKey(uid, stem)),
  targetLabel: "Claim",
  targetProperty: "kind",
  targetValues: [claimKind(uid)],
  relTypes: ["HITS", "NAMES", "MENTIONS"],
  relDirection: "outgoing",
  maxLen
})

/** One arm's reads, with the query it ran, for the receipt. */
export interface LiveArm extends ArmResult {
  readonly query: string | null
  readonly paths: number
}

const emptyArm = (kind: ArmKind, label: string): LiveArm => ({
  kind,
  label,
  claims: [],
  query: null,
  paths: 0
})

/** The convergence walk: today's Query 1, widened for the selector. */
export const convergenceArm = (
  hydra: HydraClient,
  uid: string,
  terms: ReadonlyArray<string>,
  total: number,
  maxLen: number
): Effect.Effect<LiveArm, HydraError> =>
  Effect.gen(function* () {
    if (terms.length === 0) return emptyArm("convergence", "convergence")
    const config = convergenceConfig(uid, terms, maxLen)
    const paths = yield* hydra.msPaths(config)
    return {
      kind: "convergence",
      label: "convergence",
      claims: scoreReached(paths, total),
      query: renderMsPathsQuery(config).query,
      paths: paths.length
    }
  })

/**
 * A sub-question's own convergence walk.
 *
 * The terms come from the Understand call, which returns them *with* each
 * sub-question — so decomposing a question costs no extra LLM round trip, only
 * an extra graph read that runs beside the others.
 */
export const subQuestionArm = (
  hydra: HydraClient,
  uid: string,
  sub: SubQuestion,
  index: number,
  total: number,
  maxLen: number
): Effect.Effect<LiveArm, HydraError> =>
  Effect.gen(function* () {
    const label = `sub:${index}`
    if (sub.terms.length === 0) return emptyArm("subQuestion", label)
    const config = convergenceConfig(uid, sub.terms, maxLen)
    const paths = yield* hydra.msPaths(config)
    return {
      kind: "subQuestion",
      label,
      claims: scoreReached(paths, total),
      query: renderMsPathsQuery(config).query,
      paths: paths.length
    }
  })

/**
 * A Slot read for an `(entity, attribute)` the question named outright.
 *
 * This is the arm that answers "how many years older is my grandma than me":
 * nothing lexical reaches the `(me, age)` claim, and it is one indexed read
 * away. A Slot that does not exist is an empty arm, not an error — the model
 * proposes the pair, the graph decides whether it is there.
 *
 * The claims come back scored with **zero** anchors, exactly as v1's slot-mates
 * do: they did not converge, they were named. The union's arm priority is what
 * keeps them, not a score they did not earn.
 */
export const probeArm = (
  hydra: HydraClient,
  uid: string,
  probe: Probe,
  total: number
): Effect.Effect<LiveArm, HydraError> =>
  Effect.gen(function* () {
    const label = `probe:${probe.entityCanon}|${probe.attr}`
    const config: MsPathsConfig = {
      sourceLabel: "Slot",
      sourceProperty: "skey",
      sourceValues: [slotKey(uid, probe.entityCanon, probe.attr)],
      targetLabel: "Claim",
      targetProperty: "kind",
      targetValues: [claimKind(uid)],
      relTypes: ["FILLS"],
      relDirection: "incoming",
      maxLen: 1
    }
    const paths = yield* hydra.msPaths(config)
    return {
      kind: "probe",
      label,
      claims: scoreReached(paths, total).map((claim) => ({
        ...claim,
        anchors: [],
        convergence: 0,
        score: 0
      })),
      query: renderMsPathsQuery(config).query,
      paths: paths.length
    }
  })

/** How many terms the discovery walk may seed itself with. */
export const MAX_DISCOVERY_SEEDS = 20

/**
 * Terms to try that the question did not supply, from what the first walk found.
 *
 * Two sources, both deterministic and both free of another LLM call: the
 * **entities** a two-hop path passed through — `Token→Entity→Claim` means that
 * Entity is a name the question's own words reached — and terms from the top
 * candidates' index text.
 *
 * Ranked by *rarity within the candidate set*: a term in one of the top ten
 * candidates discriminates between them, a term in nine does not. That is an
 * idf-shaped signal computable from what is already in hand. The spec asks for
 * idf from the Token `df`, which `Scoring` reads only for terms that were
 * already anchors — and a term that was already an anchor discovers nothing.
 * The deviation is here rather than hidden.
 */
export const discoverySeeds = (
  paths: ReadonlyArray<HydraPath>,
  top: ReadonlyArray<ReachedClaim>,
  alreadyAnchors: ReadonlySet<string>
): ReadonlyArray<string> => {
  const seeds = new Map<string, number>()

  for (const path of paths) {
    if (path.nodes.length !== 3) continue
    const middle = path.nodes[1]
    const name = String(middle?.properties["name"] ?? "")
    if (name === "") continue
    for (const s of stems(name)) {
      if (!alreadyAnchors.has(s)) seeds.set(s, 0)
    }
  }

  const frequency = new Map<string, number>()
  for (const claim of top) {
    for (const s of new Set(stems(claim.text))) {
      if (alreadyAnchors.has(s)) continue
      frequency.set(s, (frequency.get(s) ?? 0) + 1)
    }
  }
  for (const [term, n] of frequency) {
    if (!seeds.has(term)) seeds.set(term, n)
  }

  return [...seeds.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_DISCOVERY_SEEDS)
    .map(([term]) => term)
}

/** One more convergence walk, from terms the question never said. */
export const discoveryArm = (
  hydra: HydraClient,
  uid: string,
  seeds: ReadonlyArray<string>,
  total: number,
  maxLen: number
): Effect.Effect<LiveArm, HydraError> =>
  Effect.gen(function* () {
    if (seeds.length === 0) return emptyArm("discovery", "discovery")
    const config = convergenceConfig(uid, seeds, maxLen)
    const paths = yield* hydra.msPaths(config)
    return {
      kind: "discovery",
      label: "discovery",
      // Scored, but never allowed to outrank a claim the question's own words
      // reached: the union's arm priority puts discovery below convergence.
      claims: scoreReached(paths, total),
      query: renderMsPathsQuery(config).query,
      paths: paths.length
    }
  })
