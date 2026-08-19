import type { LanguageModel } from "@effect/ai"
import { Llm } from "@palimpsest/llm"
import { Effect, Schema } from "effect"
import { stems } from "./Tokenize.js"

/**
 * Turning a question into anchors.
 *
 * The deterministic stems of the question are always included — that half needs
 * no model and cannot fail. The LLM adds the half that matters for recall:
 * synonyms and hypernyms, so a question about "my jacket" can still reach a
 * claim written about "outerwear". This is the read-time mirror of the
 * write-time `keywords` expansion; both sides have to widen or the exact-match
 * join in the middle never happens.
 */

const Anchors = Schema.Struct({
  /** Content words, plus synonyms and hypernyms of each. */
  anchor_terms: Schema.Array(Schema.String),
  /** True when the question asks what *was* true, not what is true now. */
  historical: Schema.Boolean,
  /** True when the answer is a number of things ("how many …"). */
  wants_count: Schema.Boolean,
  /** A date or period the question refers to, or null. */
  time_ref: Schema.NullOr(Schema.String)
})

export interface QuestionAnchors {
  /** Stems, de-duplicated, in a stable order. */
  readonly terms: ReadonlyArray<string>
  readonly historical: boolean
  readonly wantsCount: boolean
  readonly timeRef: string | null
  readonly expanded: ReadonlyArray<string>
  readonly cached: boolean
}

const SYSTEM = `You turn a question into search terms for a memory of one person's chat history.

Return the words a claim about the answer would plausibly contain — not a query, a bag of terms.

- Include every content word of the question.
- Include synonyms and hypernyms for each of them, because the memory may have recorded the fact in
  different words: "jacket" -> coat, clothing, apparel, outerwear; "hamster" -> pet, rodent, animal;
  "pre-approved" -> approval, mortgage, loan, lender; "hurt" -> pain, injury, ache.
- Include the specific proper nouns exactly as written, and their common short forms.
- Do NOT include words that describe the asking rather than the answer — "remember", "tell", "what",
  "when", "did", "I", "my".
- 6 to 20 terms. Single words or short phrases.

Also judge the question itself:
- historical: true when it asks what was true at some past point, or how something changed, rather
  than what is true now. "Where did I live before I moved?" is historical; "Where do I live?" is not.
- wants_count: true when the answer is a quantity of things ("how many …", "what did I list").
- time_ref: the date or period the question points at, verbatim from the question, or null.`

export const questionAnchors = (
  question: string,
  questionDate?: string
): Effect.Effect<QuestionAnchors, never, LanguageModel.LanguageModel | Llm> =>
  Effect.gen(function* () {
    const llm = yield* Llm
    const generated = yield* llm
      .generateObject({
        kind: "anchors",
        system: SYSTEM,
        prompt:
          questionDate === undefined
            ? `QUESTION: ${question}`
            : `QUESTION DATE: ${questionDate}\nQUESTION: ${question}`,
        schema: Anchors,
        objectName: "anchors"
      })
      .pipe(Effect.orDie)

    // The question's own stems are unconditional: if the model returns nothing
    // useful, retrieval still has the literal words to work with.
    const terms = new Set<string>()
    for (const stem of stems(question)) terms.add(stem)
    for (const term of generated.value.anchor_terms) {
      for (const stem of stems(term)) terms.add(stem)
    }

    return {
      terms: [...terms].sort(),
      historical: generated.value.historical,
      wantsCount: generated.value.wants_count,
      timeRef: generated.value.time_ref,
      expanded: generated.value.anchor_terms,
      cached: generated.cached
    }
  })
