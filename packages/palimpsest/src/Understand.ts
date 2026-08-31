import type { LanguageModel } from "@effect/ai"
import { Llm } from "@palimpsest/llm"
import { Effect, Schema } from "effect"
import { ATTRIBUTE_VOCABULARY } from "./Extract.js"
import { resolveTimeInterval, type DayInterval } from "./TimeScope.js"
import { stem, stems } from "./Tokenize.js"

/**
 * Understanding the question, once, before anything is read.
 *
 * v1 asked the model for search terms and three booleans, and consumed two of
 * them. This asks the same call for the rest of what the shape of the answer
 * depends on — which *kind* of question it is, what it decomposes into, which
 * `(entity, attribute)` pairs it names outright — and consumes all of it.
 *
 * The division of labour is the point. The model is asked only for things a
 * model is good at: paraphrase, decomposition, naming the attribute behind a
 * noun. Everything with a right answer stays in code: the interval comes from
 * `TimeScope`, and a handful of deterministic cues override the route where the
 * question says outright what it is, so "how many X" is never classified as a
 * preference no matter what the model returns.
 */

/**
 * The primary route. It drives two things and only two: which reader prompt is
 * appended, and how much text is hydrated around each span.
 *
 * Flags are *not* routes and are independent of it — a count question with a
 * time phrase gets the count reader **and** the time scope — because collapsing
 * them into one label is how v1 ended up with one shape for six kinds of
 * question.
 */
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

/** At most four, each self-contained, each carrying its own search terms. */
export const MAX_SUB_QUESTIONS = 4
/** At most six `(entity, attribute)` pairs to read Slots for directly. */
export const MAX_PROBES = 6

const Understanding = Schema.Struct({
  /** Content words, plus synonyms and hypernyms of each. Unchanged from v1. */
  anchor_terms: Schema.Array(Schema.String),
  historical: Schema.Boolean,
  wants_count: Schema.Boolean,
  time_ref: Schema.NullOr(Schema.String),
  route: Schema.Literal(...ROUTES),
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
  /** Stems, de-duplicated and sorted, exactly as the primary anchors are. */
  readonly terms: ReadonlyArray<string>
}

export interface Probe {
  readonly entityCanon: string
  readonly attr: string
}

export interface Understood {
  /** Stems, de-duplicated, in a stable order. The convergence arm's sources. */
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
  /** The phrase the model returned, verbatim. */
  readonly timeRef: string | null
  /** Resolved in code, or `null` when the phrase is not one of the supported forms. */
  readonly timeInterval: DayInterval | null
  readonly subQuestions: ReadonlyArray<SubQuestion>
  readonly probes: ReadonlyArray<Probe>
  readonly expanded: ReadonlyArray<string>
  readonly cached: boolean
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

/**
 * Words that make a question's kind unambiguous whatever the model says.
 *
 * Kept small on purpose. A cue only earns its place when the question states
 * its own kind in words — "how many" is a count, full stop — because every cue
 * is a rule that fires on questions nobody looked at.
 */
/**
 * **Narrowed on 2026-08-31, from evidence.** It was
 * `/\b(how many|how much|how often|how numerous)\b/`, and on the first v2 dev
 * run that put **21 of 36 questions on the `count` route** — 9 multi-session, 7
 * knowledge-update and 4 temporal-reasoning, none of which is a count. "How
 * much did I pay" is a fact and "how often do I go" is a frequency; neither is
 * a list to enumerate, which is what the route's reader rule asks for.
 *
 * The spec names exactly one phrase for this cue, `how many`, and the widening
 * was not in it. Three of the four wrong `count`-routed answers were
 * `INSUFFICIENT_EVIDENCE` abstentions, which is the compounding cost: the
 * sufficiency check judges a count PARTIAL whenever an item might be missing,
 * runs its second pass, and abstains — on a question that was never a count.
 */
const COUNT_PHRASE = /\bhow many\b/
const CURRENT_WORD = /\b(current|currently|now|nowadays|still|these days|at the moment)\b/
const DID_I_WITH = /\bdid i\b[^?]*\bwith\b/

const ATTRIBUTE_STEMS = new Set(
  ATTRIBUTE_VOCABULARY.flatMap((attr) => attr.split("_")).map((word) => stem(word))
)

/**
 * The route, after the deterministic cues have had their say.
 *
 * Exported so the table of question × route is a unit test rather than an eval
 * run: a route is a prompt and a hydration granularity, and getting it wrong is
 * silent.
 */
export const applyRouteCues = (
  question: string,
  modelRoute: Route,
  timeRef: string | null
): { readonly route: Route; readonly reason: string } => {
  const text = question.toLowerCase()
  // Not over `temporal`. "How many years older is my grandma than me" says
  // "how many" and is date arithmetic, not an enumeration — it is #27's own
  // example question, and the count route would tell the reader to list items
  // and total them when what it needs is to subtract two dates. A model that
  // has already called a question temporal has resolved something a regex
  // cannot, so the cue defers to it.
  if (COUNT_PHRASE.test(text) && modelRoute !== "temporal") {
    return { route: "count", reason: "cue:how_many" }
  }
  if (DID_I_WITH.test(text) && timeRef !== null) {
    return { route: "temporal", reason: "cue:did_i_with_time" }
  }
  // "currently" turns a question about a *value* into a question about the
  // latest one. The vocabulary check catches "what is my current employer";
  // the route check catches "where do I currently live", where the attribute
  // is `residence` and the question says "live" — resolving that is the
  // model's job, and it has already done it by answering `fact`.
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

/** Stems of a question plus its expansion terms, de-duplicated and ordered. */
export const anchorStems = (
  question: string,
  expanded: ReadonlyArray<string>
): ReadonlyArray<string> => {
  const terms = new Set<string>()
  for (const s of stems(question)) terms.add(s)
  for (const term of expanded) for (const s of stems(term)) terms.add(s)
  return [...terms].sort()
}

/**
 * Shapes one model answer into the plan's inputs.
 *
 * Pure, and separate from the call, so every cap, every cue and the interval
 * arithmetic are testable without a provider.
 */
export const shapeUnderstanding = (
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
      // The cue is evidence too: a question that says "how many" wants a count
      // whatever the model ticked.
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

/**
 * One structured call, in the `anchors` cache family.
 *
 * Same family as v1 deliberately: the schema is part of the cache key, so the
 * v1 entries are not reused and cannot be, and keeping the family means one
 * directory holds every question-understanding call this project has ever made.
 * The system prompt says "version 2" for the same reason.
 */
export const understand = (
  question: string,
  questionDate: number,
  questionDateRaw?: string
): Effect.Effect<Understood, never, LanguageModel.LanguageModel | Llm> =>
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
    return shapeUnderstanding(question, questionDate, generated.value, generated.cached)
  })
