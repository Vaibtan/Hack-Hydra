import type { LanguageModel } from "@effect/ai"
import { Llm, configuredModel } from "@palimpsest/llm"
import { Effect, Schema } from "effect"
import type { HydratedSpan } from "./Reader.js"
import { RoutePolicy } from "./Routes.js"
import { stems } from "./Tokenize.js"
import type { Route } from "./Understand.js"

/** `INFERRABLE` is a complete answer by arithmetic or combination, not a warning. */
export type Tier = "EXACT" | "INFERRABLE" | "PARTIAL"

export const MAX_REFINEMENT_PASSES = 1

/** Empty, chosen from the dev risk-coverage curve (`results/risk-coverage-dev.md`, 2026-08-31). */
export const ABSTAIN_TIERS: ReadonlyArray<Tier> = []

const sufficiencyModel = (): string | undefined => configuredModel("PALIMPSEST_SUFFICIENCY_MODEL")

export const MAX_MISSING_TERMS = 8

const Judgement = Schema.Struct({
  tier: Schema.Literal("EXACT", "INFERRABLE", "PARTIAL"),
  missing: Schema.String,
  missing_terms: Schema.Array(Schema.String),
  premise: Schema.String,
  premise_contradicted_by: Schema.Array(Schema.String)
})

const SYSTEM = `You judge whether a set of transcript excerpts is enough to answer a question. You do not
answer the question.

Reply with one tier:
- EXACT: the answer is stated in the excerpts.
- INFERRABLE: the answer follows from the excerpts by arithmetic, by comparing two dates, or by
  combining two of them. This is a normal, complete answer - not a warning.
- PARTIAL: something the question needs is not in the excerpts. A count that needs every item and
  has some of them is PARTIAL. A question about what changed that has only the new value is PARTIAL.

When and only when the tier is PARTIAL:
- missing: name what is absent, in one short phrase.
- missing_terms: three to eight words to search the person's history for it. Words that would appear
  in a sentence stating the missing fact - not words from the question you already searched with.

Separately, and rarely: a question can assume something the excerpts contradict - a role the person
never held, a purchase they did not make, a pet they do not have. If so, name it in premise and list
in premise_contradicted_by the ids of the excerpts that contradict it. Do NOT set premise merely
because the excerpts are silent about it; silence is PARTIAL, not a contradiction. Leave both empty
otherwise.`

export interface SufficiencyReport {
  readonly tier: Tier
  readonly missing: string
  /** Stemmed, de-duplicated, capped — ready to be arm sources. */
  readonly missingTerms: ReadonlyArray<string>
  readonly premise: string
  /** The excerpt ids the model cited, unverified; `premiseContradiction` is the only verified reading. */
  readonly premiseCitedIds: ReadonlyArray<string>
  /** The call did not run: a skipped route, an empty pack, the fast profile, or a provider error. */
  readonly skipped: boolean
  readonly cached: boolean
}

export const skipped = (reason: Tier = "EXACT"): SufficiencyReport => ({
  tier: reason,
  missing: "",
  missingTerms: [],
  premise: "",
  premiseCitedIds: [],
  skipped: true,
  cached: true
})

/** A premise counts as contradicted only when cited to an excerpt that is in the pack and CURRENT. */
export const premiseContradiction = (
  report: SufficiencyReport,
  spans: ReadonlyArray<HydratedSpan>
): { readonly premise: string; readonly citedIds: ReadonlyArray<string> } | null => {
  if (report.premise.trim() === "") return null
  const current = new Set(
    spans.filter((span) => span.status === "CURRENT").map((span) => span.id)
  )
  const cited = report.premiseCitedIds.filter((id) => current.has(id))
  return cited.length === 0 ? null : { premise: report.premise, citedIds: cited }
}

export const abstains = (report: SufficiencyReport): boolean =>
  !report.skipped && ABSTAIN_TIERS.includes(report.tier)

export const runsOn = (
  route: Route,
  spans: ReadonlyArray<HydratedSpan>,
  profile: "full" | "fast"
): boolean => profile === "full" && spans.length > 0 && RoutePolicy[route].sufficiency

export const renderPack = (spans: ReadonlyArray<HydratedSpan>): string =>
  spans
    .map((span) => {
      const status = span.status === "CURRENT" ? "CURRENT" : "SUPERSEDED"
      return `[${span.id}] session ${span.sessionOrd} on ${span.sessionDate}, ${span.speaker}, ${status}\n${span.excerpt}`
    })
    .join("\n\n")

/** One cached call in its own family; a failed call is `skipped`, never `PARTIAL`. */
export const judgeSufficiency = (
  question: string,
  questionDate: string,
  route: Route,
  spans: ReadonlyArray<HydratedSpan>
): Effect.Effect<SufficiencyReport, never, LanguageModel.LanguageModel | Llm> =>
  Effect.gen(function* () {
    const prompt = [
      `QUESTION DATE: ${questionDate}`,
      `QUESTION: ${question}`,
      `QUESTION KIND: ${route}`,
      "",
      `EXCERPTS (${spans.length}):`,
      renderPack(spans)
    ].join("\n")

    const generated = yield* Effect.either(
      (yield* Llm).generateObject({
        kind: "sufficiency",
        system: SYSTEM,
        prompt,
        schema: Judgement,
        objectName: "sufficiency",
        ...(sufficiencyModel() === undefined ? {} : { model: sufficiencyModel()! })
      })
    )
    if (generated._tag === "Left") return skipped()

    const value = generated.right.value
    const terms = new Set<string>()
    for (const term of value.missing_terms) {
      for (const stem of stems(term)) terms.add(stem)
    }
    return {
      tier: value.tier,
      missing: value.missing,
      missingTerms: [...terms].sort().slice(0, MAX_MISSING_TERMS),
      premise: value.premise,
      premiseCitedIds: value.premise_contradicted_by,
      skipped: false,
      cached: generated.right.cached
    }
  })
