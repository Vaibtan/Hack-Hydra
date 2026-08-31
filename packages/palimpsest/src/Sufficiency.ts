import type { LanguageModel } from "@effect/ai"
import { Llm } from "@palimpsest/llm"
import { Effect, Schema } from "effect"
import type { HydratedSpan } from "./Reader.js"
import { stems } from "./Tokenize.js"
import type { Route } from "./Understand.js"

/**
 * Asking whether the excerpts actually answer the question, before answering.
 *
 * The research finding this stage exists for is blunt: on this benchmark the
 * misses are overwhelmingly *post-retrieval*. The answer session is in the
 * candidate set and the reader still gets it wrong, usually because the pack
 * holds most of what the question needs and not all of it — four of the five
 * items in a count, the new value of a slot but not the old one. A reader
 * handed nine tenths of an answer produces a confident wrong one; it does not
 * say so.
 *
 * So this is a check on the *pack*, run between packing and reading, and its
 * only two outputs are "read it" and "go back for the missing piece, once".
 *
 * It is not an abstention oracle. `INSUFFICIENT_EVIDENCE` is what is left when
 * the second pass did not help, and abstaining is the *expensive* answer on a
 * benchmark where 470 of 500 questions are answerable — which is why the tier
 * that triggers it is a constant chosen from a risk-coverage curve rather than
 * a judgement made per question.
 */

/**
 * How well the packed excerpts support an answer.
 *
 * `EXACT` — the answer is stated in the excerpts. `INFERRABLE` — it follows
 * from them by arithmetic or by combining two of them, which is most temporal
 * and multi-fact questions and is *not* a warning. `PARTIAL` — something the
 * question needs is not there.
 */
export type Tier = "EXACT" | "INFERRABLE" | "PARTIAL"

/**
 * The routes that never pay for this call.
 *
 * `fact` and `assistant_output` are the two where one excerpt either is the
 * answer or is not, and the reader's own `NOT_IN_MEMORY` already covers the
 * second case. They are also the two most common routes, so running the check
 * on them would put an LLM round trip on the majority of asks to catch a
 * failure mode they do not have. The `--no-sufficiency` ablation measures
 * whether that reasoning survives contact with the dev split.
 */
export const SKIP_ROUTES: ReadonlyArray<Route> = ["fact", "assistant_output"]

/** One refined pass. Not a loop — see `MAX_REFINEMENT_PASSES`. */
export const MAX_REFINEMENT_PASSES = 1

/**
 * The tiers that abstain when the second pass has already run.
 *
 * **Empty, chosen from the dev risk-coverage curve on 2026-08-31.** It shipped
 * as `["PARTIAL"]` with a comment saying it was provisional until exactly this
 * table existed. The table (`results/risk-coverage-dev.md`, 54 answerable + 6
 * `_abs`):
 *
 * | gate | coverage | correct of answered | risk | false abstention | `_abs` accuracy |
 * |---|---:|---:|---:|---:|---:|
 * | none | 100.0 % | 46/54 | 14.8 % | 0.0 % | 83.3 % |
 * | `PARTIAL` | 87.0 % | 46/47 | 2.1 % | 13.0 % | 83.3 % |
 * | `PARTIAL` + `INFERRABLE` | 64.8 % | 35/35 | 0.0 % | 35.2 % | 100.0 % |
 *
 * The `PARTIAL` gate refuses 13 % of the answerable questions and buys **no**
 * abstention accuracy for it: 5 of 6 `_abs` questions are refused correctly
 * with the gate and 5 of 6 without it. Its 2.1 % risk looks like a strong
 * number and is not one — 46 of 47 correct means the reader is nearly perfect
 * on what it answers, so every question the gate withholds is one it would
 * probably have got right. Seven were withheld; three of those were
 * multi-session questions v1 answered correctly, which was the whole of v2's
 * −2 on that type.
 *
 * `PARTIAL + INFERRABLE` is the only setting that reaches 6/6 on `_abs`, and it
 * costs 35 % of the answerable split to do it. That is not a trade this
 * benchmark can make: 470 of LongMemEval's 500 questions are answerable.
 *
 * **This does not disable the stage.** The check still runs, still classifies,
 * and `PARTIAL` with named missing terms still triggers the one refined pass —
 * the widening is what the stage is worth, and it is separate from the refusal.
 * What is empty is the set of tiers that turn a read answer into
 * `INSUFFICIENT_EVIDENCE`. `CONTRADICTED_PREMISE` is unaffected: it is
 * evidence-backed and gated on a cited CURRENT claim, not on a tier.
 *
 * So `INSUFFICIENT_EVIDENCE` is implemented, tested and never reached at this
 * threshold. That is the honest state — the reason is in the table above, and
 * the constant is one line to move if a later population disagrees.
 */
export const ABSTAIN_TIERS: ReadonlyArray<Tier> = []

/**
 * The check's model, when one is set. Read per call for the same reason the
 * selector's is: `loadDotEnv()` runs after this module is evaluated.
 */
const sufficiencyModel = (): string | undefined => {
  const configured = process.env["PALIMPSEST_SUFFICIENCY_MODEL"]
  return configured === undefined || configured === "" ? undefined : configured
}

/** How many missing-information terms the second pass may search with. */
export const MAX_MISSING_TERMS = 8

const Judgement = Schema.Struct({
  tier: Schema.Literal("EXACT", "INFERRABLE", "PARTIAL"),
  /** What is missing, in the question's own words. Empty unless PARTIAL. */
  missing: Schema.String,
  /** Search terms for the missing piece — the second pass's extra anchors. */
  missing_terms: Schema.Array(Schema.String),
  /** A thing the question assumes that the excerpts contradict. Empty if none. */
  premise: Schema.String,
  /** The excerpt ids that contradict it. Empty unless `premise` is set. */
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
  /** Excerpt ids the model said contradict the premise, after verification. */
  readonly premiseContradictedBy: ReadonlyArray<string>
  /** The call did not run. `skipped` routes, an empty pack, or the fast profile. */
  readonly skipped: boolean
  readonly cached: boolean
}

export const skipped = (reason: Tier = "EXACT"): SufficiencyReport => ({
  tier: reason,
  missing: "",
  missingTerms: [],
  premise: "",
  premiseContradictedBy: [],
  skipped: true,
  cached: true
})

/**
 * Whether the named premise is actually contradicted, rather than merely
 * asserted.
 *
 * The model has to point at excerpts, and those excerpts have to be in the pack
 * and have to be `CURRENT`. A premise the model names without citing anything
 * is a guess; one cited only to a `SUPERSEDED` excerpt says the premise *used*
 * to be false, which is not a reason to refuse to answer.
 *
 * This is the guard that keeps `CONTRADICTED_PREMISE` from becoming a second,
 * unmeasured abstention path — the premise check on the reader is already a
 * measured trade, and this one has to be held to the same standard.
 */
export const premiseContradiction = (
  report: SufficiencyReport,
  spans: ReadonlyArray<HydratedSpan>
): { readonly premise: string; readonly citedIds: ReadonlyArray<string> } | null => {
  if (report.premise.trim() === "") return null
  const current = new Set(
    spans.filter((span) => span.status === "CURRENT").map((span) => span.id)
  )
  const cited = report.premiseContradictedBy.filter((id) => current.has(id))
  return cited.length === 0 ? null : { premise: report.premise, citedIds: cited }
}

/** Whether a still-`PARTIAL` verdict abstains rather than reading. */
export const abstains = (report: SufficiencyReport): boolean =>
  !report.skipped && ABSTAIN_TIERS.includes(report.tier)

/** Whether this ask pays for the check at all. */
export const runsOn = (
  route: Route,
  spans: ReadonlyArray<HydratedSpan>,
  profile: "full" | "fast"
): boolean => profile === "full" && spans.length > 0 && !SKIP_ROUTES.includes(route)

/** The excerpt table the judge reads. Same ids the reader cites. */
export const renderPack = (spans: ReadonlyArray<HydratedSpan>): string =>
  spans
    .map((span) => {
      const status = span.status === "CURRENT" ? "CURRENT" : "SUPERSEDED"
      return `[${span.id}] session ${span.sessionOrd} on ${span.sessionDate}, ${span.speaker}, ${status}\n${span.excerpt}`
    })
    .join("\n\n")

/**
 * One cached call in its own family.
 *
 * Its own family because the prompt and schema are its own, and because a
 * results run has to be able to say what the sufficiency check cost separately
 * from what the reader cost.
 *
 * A failed call is `EXACT` and `skipped`, not `PARTIAL`: this stage can only
 * ever *withhold* an answer the pipeline was otherwise going to give, so a
 * provider error must not be able to turn a working ask into an abstention.
 */
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
      premiseContradictedBy: value.premise_contradicted_by,
      skipped: false,
      cached: generated.right.cached
    }
  })
