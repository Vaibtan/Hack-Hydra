import { Llm } from "@palimpsest/llm"
import { Effect, Schema } from "effect"
import { ATTRIBUTE_VOCABULARY } from "./Extract.js"
import { resolveTimeInterval, type DayInterval } from "./TimeScope.js"
import { stem, stems } from "./Tokenize.js"

export const ROUTES = [
  "fact",
  "preference",
  "assistant_output",
  "update",
  "count",
  "temporal",
  "multi_fact"
] as const

export type Route = (typeof ROUTES)[number]

export const MAX_SUB_QUESTIONS = 4
export const MAX_PROBES = 6

const Understanding = Schema.Struct({
  anchor_terms: Schema.Array(Schema.String),
  historical: Schema.Boolean,
  wants_count: Schema.Boolean,
  time_ref: Schema.NullOr(Schema.String),
  route: Schema.Literals([...ROUTES]),
  sub_questions: Schema.Array(
    Schema.Struct({
      question: Schema.String,
      anchor_terms: Schema.Array(Schema.String)
    })
  ),
  probes: Schema.Array(
    Schema.Struct({
      entity_canon: Schema.String,
      attr: Schema.String
    })
  )
})

export interface SubQuestion {
  readonly question: string
  readonly terms: ReadonlyArray<string>
}

export interface Probe {
  readonly entityCanon: string
  readonly attr: string
}

export interface Understood {
  readonly terms: ReadonlyArray<string>
  readonly historical: boolean
  readonly route: Route
  /** `model`, or `cue:<name>` when a deterministic cue overrode it. */
  readonly routeReason: string
  readonly flags: {
    readonly wantsCount: boolean
    readonly hasTimeRef: boolean
    readonly needsDecomposition: boolean
  }
  readonly timeRef: string | null
  /** Resolved in code, or `null` when the phrase is not one of the supported forms. */
  readonly timeInterval: DayInterval | null
  readonly subQuestions: ReadonlyArray<SubQuestion>
  readonly probes: ReadonlyArray<Probe>
  readonly expanded: ReadonlyArray<string>
  readonly cached: boolean
}

export interface RouteCue {
  readonly route: Route
  readonly reason: string
}

const SYSTEM = `You read one question about a person's chat history and describe what answering it needs.
This is version 2 of this task: as well as search terms, you now classify the question and break it up.

TERMS
Return the words a claim about the answer would plausibly contain — not a query, a bag of terms.
- Include every content word of the question.
- Include synonyms and hypernyms for each of them, because the memory may have recorded the fact in
  different words: "jacket" -> coat, clothing, apparel, outerwear; "hamster" -> pet, rodent, animal;
  "pre-approved" -> approval, mortgage, loan, lender; "hurt" -> pain, injury, ache.
- Include the specific proper nouns exactly as written, and their common short forms.
- Do NOT include words that describe the asking rather than the answer — "remember", "tell", "what",
  "when", "did", "I", "my".
- 6 to 20 terms. Single words or short phrases.

ROUTE — the single kind that best describes what the answer looks like:
- fact: a value the person stated. "What is my hamster called?"
- preference: a suggestion or recommendation that should build on what the person likes and owns.
- assistant_output: what the assistant said, listed or recommended earlier. "What did you suggest?"
- update: a value that changed, where the current one is wanted. "Where do I live now?"
- count: a quantity, or a list to enumerate. "How many things do I need to pick up?"
- temporal: needs date arithmetic or a specific past window. "How long ago did I start?"
- multi_fact: needs two or more separate facts combined. "How much older is my grandma than me?"

JUDGEMENTS
- historical: true when it asks what was true at some past point, or how something changed, rather
  than what is true now. "Where did I live before I moved?" is historical; "Where do I live?" is not.
- wants_count: true when the answer is a quantity of things.
- time_ref: the date or period the question points at, verbatim from the question, or null. Do NOT
  convert it to a date — copy the words.

SUB_QUESTIONS — 0 to ${MAX_SUB_QUESTIONS}, and only when the question genuinely needs more than one fact.
Each must be answerable on its own, and each carries its own anchor_terms in the same style as above.
"How many years older is my grandma than me?" -> ["How old is my grandma?", "How old am I?"].
A question that needs one fact returns an empty list.

PROBES — 0 to ${MAX_PROBES} (entity, attribute) pairs the question names outright, where the attribute
comes from this vocabulary: ${ATTRIBUTE_VOCABULARY.join(", ")}.
Use "me" for the person asking. "How old is my grandma?" -> [{entity_canon: "grandma", attr: "age"}].
Return an empty list when the question names no attribute from the vocabulary.`

const COUNT_PHRASE = /\bhow many\b/
const CURRENT_WORD = /\b(current|currently|now|nowadays|still|these days|at the moment)\b/
const DID_I_WITH = /\bdid i\b[^?]*\bwith\b/

const ATTRIBUTE_STEMS = new Set(
  ATTRIBUTE_VOCABULARY.flatMap((attr) => attr.split("_")).map((word) => stem(word))
)

export const applyRouteCues = (
  question: string,
  modelRoute: Route,
  timeRef: string | null
): RouteCue => {
  const text = question.toLowerCase()
  if (COUNT_PHRASE.test(text) && modelRoute !== "temporal") {
    return { route: "count", reason: "cue:how_many" }
  }
  if (DID_I_WITH.test(text) && timeRef !== null) {
    return { route: "temporal", reason: "cue:did_i_with_time" }
  }
  if (
    CURRENT_WORD.test(text) &&
    (modelRoute === "fact" ||
      modelRoute === "multi_fact" ||
      stems(question).some((s) => ATTRIBUTE_STEMS.has(s)))
  ) {
    return { route: "update", reason: "cue:currently" }
  }
  return { route: modelRoute, reason: "model" }
}

export const anchorStems = (
  question: string,
  expanded: ReadonlyArray<string>
): ReadonlyArray<string> => {
  const terms = new Set<string>()
  for (const s of stems(question)) terms.add(s)
  for (const term of expanded) for (const s of stems(term)) terms.add(s)
  return [...terms].sort()
}

export const assembleUnderstanding = (
  question: string,
  questionDate: number,
  value: Schema.Schema.Type<typeof Understanding>,
  cached: boolean
): Understood => {
  const cue = applyRouteCues(question, value.route, value.time_ref)
  const subQuestions = value.sub_questions
    .filter((sub) => sub.question.trim() !== "")
    .slice(0, MAX_SUB_QUESTIONS)
    .map((sub) => ({
      question: sub.question,
      terms: anchorStems(sub.question, sub.anchor_terms)
    }))
  const probes = value.probes
    .filter((probe) => probe.entity_canon.trim() !== "" && probe.attr.trim() !== "")
    .slice(0, MAX_PROBES)
    .map((probe) => ({
      entityCanon: probe.entity_canon.trim().toLowerCase(),
      attr: probe.attr.trim().toLowerCase()
    }))

  return {
    terms: anchorStems(question, value.anchor_terms),
    historical: value.historical,
    route: cue.route,
    routeReason: cue.reason,
    flags: {
      wantsCount: value.wants_count || cue.reason === "cue:how_many",
      hasTimeRef: value.time_ref !== null && value.time_ref.trim() !== "",
      needsDecomposition: subQuestions.length > 0
    },
    timeRef: value.time_ref,
    timeInterval: resolveTimeInterval(value.time_ref, questionDate),
    subQuestions,
    probes,
    expanded: value.anchor_terms,
    cached
  }
}

export const understand = (
  question: string,
  questionDate: number,
  questionDateRaw?: string
): Effect.Effect<Understood, never, Llm> =>
  Effect.gen(function* () {
    const llm = yield* Llm
    const generated = yield* llm
      .generateObject({
        kind: "anchors",
        system: SYSTEM,
        prompt:
          questionDateRaw === undefined
            ? `QUESTION: ${question}`
            : `QUESTION DATE: ${questionDateRaw}\nQUESTION: ${question}`,
        schema: Understanding,
        objectName: "understanding"
      })
      .pipe(Effect.orDie)
    return assembleUnderstanding(question, questionDate, generated.value, generated.cached)
  })
