import type { Candidate } from "./Arms.js"

/**
 * Choosing, from the candidate union, what the reader is actually shown.
 *
 * v1 had no selection: the top 25 by convergence plus up to 40 unranked
 * slot-mates went straight to the reader, in one shape for every question. The
 * research is consistent that more candidates without a selector *hurts* a
 * strong reader, which is why this stage exists — and equally consistent that a
 * listwise selector is where a pipeline quietly loses the one row that answers
 * the question, which is why everything in this module is a guarantee the model
 * cannot override.
 *
 * The selector sees the derived Claim `text`. That is allowed here and nowhere
 * else: it is an index entry, and it never reaches the reader.
 */

/** The short id the selector cites. The claim key's tail, as the reader's is. */
export const shortId = (ckey: string): string => ckey.slice(-8)

/**
 * How many turns may survive selection.
 *
 * Turns, not claims: several claims from one turn are one excerpt, and the
 * budget the reader pays is per excerpt.
 */
export const MAX_KEPT_TURNS = 30

/**
 * The top convergence candidates that are kept whatever the selector says.
 *
 * Three, because convergence is the structural verdict's own evidence: a claim
 * reached by several distinct question anchors is the thing the receipt points
 * at, and a selector that drops all of them has contradicted the verdict that
 * let the question be answered at all.
 */
export const ALWAYS_KEEP_TOP_CONVERGENCE = 3

/** Why a candidate did not reach the reader. */
export type DropReason = "selector" | "turn_cap"

export interface SelectionReport {
  readonly kept: ReadonlyArray<Candidate>
  readonly dropped: ReadonlyArray<{ readonly candidate: Candidate; readonly reason: DropReason }>
  /** The selector call failed and the deterministic v1 ordering was used. */
  readonly fallback: boolean
}

/**
 * The deterministic ordering the candidate table is rendered in, and the
 * fallback the pipeline uses when the selector call fails.
 *
 * Stable ordering is not tidiness: the prompt is the cache key, so an order
 * that depends on map iteration would make a replay a cache miss and a new
 * charge, and "replay costs $0" is a claim this project makes.
 */
export const orderCandidates = (
  candidates: ReadonlyArray<Candidate>
): ReadonlyArray<Candidate> =>
  [...candidates].sort(
    (a, b) =>
      b.convergence - a.convergence ||
      b.score - a.score ||
      b.sessionOrd - a.sessionOrd ||
      a.ckey.localeCompare(b.ckey)
  )

/**
 * Applies the selector's answer, with the guarantees it may not break.
 *
 * In order: every probe hit stays, the top few convergence claims stay, then
 * whatever the selector kept, then the turn cap. `keptIds` is what the model
 * returned; anything it does not name is dropped as `selector`, and anything
 * the cap removes is dropped as `turn_cap`, so the receipt can tell a model's
 * decision from a budget's.
 *
 * `fallback` replaces the model's answer entirely with the deterministic v1
 * ordering — a selector that failed must not be able to empty the evidence set.
 */
export const enforceSelection = (
  candidates: ReadonlyArray<Candidate>,
  keptIds: ReadonlySet<string>,
  options: {
    readonly fallback?: boolean
    readonly maxTurns?: number
    readonly topConvergence?: number
  } = {}
): SelectionReport => {
  const ordered = orderCandidates(candidates)
  const maxTurns = options.maxTurns ?? MAX_KEPT_TURNS
  const topConvergence = options.topConvergence ?? ALWAYS_KEEP_TOP_CONVERGENCE

  if (options.fallback === true) {
    const kept = ordered.slice(0, maxTurns)
    return {
      kept,
      dropped: ordered.slice(maxTurns).map((candidate) => ({ candidate, reason: "turn_cap" })),
      fallback: true
    }
  }

  const guaranteed = new Set<string>()
  for (const candidate of ordered) {
    if (candidate.kind === "probe") guaranteed.add(candidate.ckey)
  }
  for (const candidate of ordered.filter((c) => c.convergence > 0).slice(0, topConvergence)) {
    guaranteed.add(candidate.ckey)
  }

  const rejected = ordered.filter(
    (candidate) => !guaranteed.has(candidate.ckey) && !keptIds.has(shortId(candidate.ckey))
  )

  // The cap counts turns, so several claims from one turn cost one place — and
  // it is applied to the *selector's* rows, never to the guaranteed ones.
  //
  // The order this walks in is the whole of the guarantee. `ordered` sorts by
  // convergence, and a probe hit has convergence **0** by construction: the
  // probe arm resolves a Slot by key, not through question anchors, and the
  // claim it exists for is the one "nothing lexical reaches". So walking
  // `ordered` and capping as it goes puts every guaranteed probe hit last and
  // discards it first — which is what this function did, silently, while its
  // own docstring promised the opposite. `applyBudget` in `Pack.ts` had it
  // right: a protected row is skipped when cutting, not sorted into the cut.
  const turns = new Set<string>()
  const keptKeys = new Set<string>()
  const take = (candidate: Candidate): void => {
    turns.add(`${candidate.sessionKey}|${candidate.turnIdx}`)
    keptKeys.add(candidate.ckey)
  }

  for (const candidate of ordered) {
    if (guaranteed.has(candidate.ckey)) take(candidate)
  }
  const cappedOut: Array<Candidate> = []
  for (const candidate of ordered) {
    if (guaranteed.has(candidate.ckey)) continue
    if (!keptIds.has(shortId(candidate.ckey))) continue
    const turn = `${candidate.sessionKey}|${candidate.turnIdx}`
    if (turns.size >= maxTurns && !turns.has(turn)) {
      cappedOut.push(candidate)
      continue
    }
    take(candidate)
  }

  return {
    // Emitted in `ordered` order, because the budget stage cuts from the tail
    // of the selector's ranking and that ranking is this one.
    kept: ordered.filter((candidate) => keptKeys.has(candidate.ckey)),
    dropped: [
      ...rejected.map((candidate) => ({ candidate, reason: "selector" as const })),
      ...cappedOut.map((candidate) => ({ candidate, reason: "turn_cap" as const }))
    ],
    fallback: false
  }
}

/**
 * Whether the selector is showing the speaker prior the research warns about.
 *
 * 72 % of claims are assistant-sourced, so a selector that simply prefers them
 * is reproducing the corpus rather than answering the question. This measures
 * it on dev; the fix, if it is needed, is a deterministic pre-sort, not a
 * prompt tweak — a prompt that argues with a prior is not a control.
 */
export const speakerShare = (
  candidates: ReadonlyArray<Candidate>,
  kept: ReadonlyArray<Candidate>
): { readonly candidateShare: number; readonly keptShare: number } => {
  const share = (rows: ReadonlyArray<Candidate>): number =>
    rows.length === 0 ? 0 : rows.filter((row) => row.speaker === "assistant").length / rows.length
  return { candidateShare: share(candidates), keptShare: share(kept) }
}
