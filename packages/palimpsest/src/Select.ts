import type { LanguageModel } from "@effect/ai"
import { Llm, configuredModel } from "@palimpsest/llm"
import { Effect, Schema } from "effect"
import type { Candidate } from "./Arms.js"
import type { Route } from "./Understand.js"

const selectModel = (): string | undefined => configuredModel("PALIMPSEST_SELECT_MODEL")

/** The short id the selector cites. The claim key's tail, as the reader's is. */
export const shortId = (ckey: string): string => ckey.slice(-8)

export const MAX_KEPT_TURNS = 30

export const ALWAYS_KEEP_TOP_CONVERGENCE = 3

/** Why a candidate did not reach the reader. */
export type DropReason = "selector" | "turn_cap"

export interface SelectionReport {
  readonly kept: ReadonlyArray<Candidate>
  readonly dropped: ReadonlyArray<{ readonly candidate: Candidate; readonly reason: DropReason }>
  /** The selector call failed and the deterministic v1 ordering was used. */
  readonly fallback: boolean
}

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
    kept: ordered.filter((candidate) => keptKeys.has(candidate.ckey)),
    dropped: [
      ...rejected.map((candidate) => ({ candidate, reason: "selector" as const })),
      ...cappedOut.map((candidate) => ({ candidate, reason: "turn_cap" as const }))
    ],
    fallback: false
  }
}

export const speakerShare = (
  candidates: ReadonlyArray<Candidate>,
  kept: ReadonlyArray<Candidate>
): { readonly candidateShare: number; readonly keptShare: number } => {
  const share = (rows: ReadonlyArray<Candidate>): number =>
    rows.length === 0 ? 0 : rows.filter((row) => row.speaker === "assistant").length / rows.length
  return { candidateShare: share(candidates), keptShare: share(kept) }
}

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
