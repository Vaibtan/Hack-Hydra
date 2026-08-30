import type { LanguageModel } from "@effect/ai"
import { Llm } from "@palimpsest/llm"
import { Effect, Schema } from "effect"
import type { Candidate } from "./Arms.js"
import type { Route } from "./Understand.js"

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

/**
 * The selector's model, when one is set. Read per call, not at module load:
 * `loadDotEnv()` runs inside a CLI's body, and ESM has already evaluated this
 * module by then.
 */
const selectModel = (): string | undefined => {
  const configured = process.env["PALIMPSEST_SELECT_MODEL"]
  return configured === undefined || configured === "" ? undefined : configured
}

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

// ------------------------------------------------------------- the LLM call

const Selection = Schema.Struct({
  keep: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      /** One word: why this row helps. Shown in the receipt, not acted on. */
      reason: Schema.String
    })
  )
})

const SYSTEM = `You choose which memory excerpts a reader will be shown, from a table of candidates.

Each row is one recorded claim about the person asking: a short id, the claim as the memory indexed
it, who said it, the date of the conversation, the date the claim is about, and whether the memory
still considers it current.

Keep the rows that help answer the question. Specifically:
- Keep every row the answer needs. A count or a comparison needs ALL of its contributing rows, not
  the best one — if the question asks how many things, keep every distinct thing.
- Keep BOTH values when the question is about something that changed, so the reader can see which
  is current and which was replaced.
- Prefer distinct facts over near-duplicates. When several rows say the same thing, keep the one
  with the most specific wording and drop the rest.
- Drop rows that are merely about the same topic. Overlapping words are not evidence.
- Do not try to answer the question. Choosing is the whole job.

Return the ids you keep, each with a one-word reason. Keeping nothing is never correct: if no row
is clearly relevant, keep the handful that are closest.`

/** The candidate table, one row per line, in a stable order. */
export const renderCandidateTable = (candidates: ReadonlyArray<Candidate>): string =>
  orderCandidates(candidates)
    .map((candidate) => {
      const dated = candidate.tEvent > 0 ? ` about ${candidate.tEvent}` : ""
      return (
        `[${shortId(candidate.ckey)}] ${candidate.speaker} on ${candidate.sessionDate}${dated} · ` +
        `${candidate.arms.join(",")} · ${candidate.text}`
      )
    })
    .join("\n")

export interface SelectorCall extends SelectionReport {
  /** The one-word reason the model gave for each kept id. */
  readonly reasons: Readonly<Record<string, string>>
  readonly cached: boolean
}

/**
 * One listwise call over the whole candidate table.
 *
 * Listwise, not one call per row: the decisions are not independent — "keep
 * every distinct item" and "prefer distinct facts over near-duplicates" are
 * both statements about the *set*, and a per-row call cannot see the set.
 *
 * The model sees the derived Claim `text`. That is allowed here and nowhere
 * else: it is an index entry written by an earlier model, and answering from it
 * would make the system a summary of a summary. It never reaches the reader.
 *
 * A failed call is not a decision: `enforceSelection` falls back to the
 * deterministic v1 ordering rather than letting an error empty the evidence.
 */
export const select = (
  question: string,
  questionDate: string,
  route: Route,
  candidates: ReadonlyArray<Candidate>,
  options: { readonly maxTurns?: number } = {}
): Effect.Effect<SelectorCall, never, LanguageModel.LanguageModel | Llm> =>
  Effect.gen(function* () {
    if (candidates.length === 0) {
      return {
        ...enforceSelection([], new Set(), options),
        reasons: {},
        cached: true
      }
    }

    const prompt = [
      `QUESTION DATE: ${questionDate}`,
      `QUESTION: ${question}`,
      `QUESTION KIND: ${route}`,
      "",
      `CANDIDATES (${candidates.length}):`,
      renderCandidateTable(candidates)
    ].join("\n")

    const generated = yield* Effect.either(
      (yield* Llm).generateObject({
        kind: "select",
        system: SYSTEM,
        prompt,
        schema: Selection,
        objectName: "selection",
        // Its own env var, defaulting to the reader's model. The selector reads
        // a table of index entries, which is a different job from answering
        // from verbatim text, so it has to be movable without moving the reader
        // -- and the reader is frozen for the whole v1-vs-v2 comparison.
        ...(selectModel() === undefined ? {} : { model: selectModel()! })
      })
    )

    if (generated._tag === "Left") {
      return {
        ...enforceSelection(candidates, new Set(), { ...options, fallback: true }),
        reasons: {},
        cached: false
      }
    }

    const reasons: Record<string, string> = {}
    for (const row of generated.right.value.keep) reasons[row.id] = row.reason
    return {
      ...enforceSelection(candidates, new Set(Object.keys(reasons)), options),
      reasons,
      cached: generated.right.cached
    }
  })

/**
 * The selection the pipeline actually uses, after the rule that a selector
 * which kept *nothing* has not made a decision.
 *
 * `select` reports `fallback: true` when the call itself failed. It cannot
 * report it for an empty keep set, because an empty keep set is a well-formed
 * answer from a working call — and it is the one answer the pipeline must not
 * take at face value. An empty pack reads downstream as "the memory does not
 * contain it", which is a different claim from "none of these rows helps", and
 * the receipt would show a successful selection behind a structural-looking
 * abstention.
 *
 * So an empty keep set falls back to the deterministic v1 ordering **and flags
 * itself**, exactly as a failed call does. The flag is the point: a dev run's
 * `selectorFallback` column has to count both, or the number is not a count of
 * "asks where the selector's judgement was not used".
 *
 * Lived inline in `askV2` until #22's review; it is here so it can be tested
 * without a graph and a live model.
 */
export const applySelection = (
  candidates: ReadonlyArray<Candidate>,
  selection: SelectionReport
): SelectionReport => {
  if (selection.kept.length > 0) return selection
  return {
    kept: orderCandidates(candidates).slice(0, MAX_KEPT_TURNS),
    dropped: selection.dropped,
    fallback: true
  }
}
