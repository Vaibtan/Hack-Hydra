import type { LanguageModel } from "@effect/ai"
import { HydraClient, type HydraError } from "@palimpsest/hydra"
import { Llm } from "@palimpsest/llm"
import { Effect, Schema } from "effect"
import type { AsOfLabelled } from "./Scoring.js"

/**
 * Reading an answer out of evidence.
 *
 * The reader never sees a Claim's text. A Claim is an *index entry* — a
 * paraphrase produced by an earlier model — and answering from it would make
 * the whole system a summary-of-a-summary. What the reader sees is the verbatim
 * turn text around each Span, which is the thing the graph was built to point
 * at. Claims survive only as ordering, labels and citation ids.
 */

/** Characters of surrounding turn text given on each side of a Span. */
export const SPAN_CONTEXT = 300

/**
 * Cuts a Span out of its turn with context on both sides, and reports where the
 * span sits inside the cut so a UI can highlight it. Clamped at both ends: a
 * span at the very start or end of a turn must not produce a negative offset or
 * one past the excerpt.
 */
export const cutExcerpt = (
  text: string,
  cs: number,
  ce: number,
  context = SPAN_CONTEXT
): { readonly excerpt: string; readonly highlight: { readonly start: number; readonly end: number } } => {
  const from = Math.max(0, Math.min(cs, text.length))
  const to = Math.max(from, Math.min(ce, text.length))
  const start = Math.max(0, from - context)
  const end = Math.min(text.length, to + context)
  const excerpt = text.slice(start, end)
  return {
    excerpt,
    highlight: { start: from - start, end: Math.min(excerpt.length, to - start) }
  }
}

export interface HydratedSpan {
  readonly ckey: string
  /** Short, stable id the reader cites — the claim key's tail. */
  readonly id: string
  readonly sid: string
  readonly sessionOrd: number
  readonly sessionDate: number
  readonly tEvent: number
  readonly speaker: string
  readonly status: "CURRENT" | "SUPERSEDED"
  readonly atSession: number | null
  /** Verbatim turn text, cut to the span plus context on both sides. */
  readonly excerpt: string
  /** Where the span sits inside `excerpt`, so a UI can highlight it. */
  readonly highlight: { readonly start: number; readonly end: number }
}

const Answer = Schema.Struct({
  answer: Schema.String,
  cited_ids: Schema.Array(Schema.String),
  /** The model's own date arithmetic, when the question needed any. */
  reasoning: Schema.String
})

/**
 * The premise-checking variant. A question can be unanswerable because its
 * *presupposition* is false rather than because the evidence is thin —
 * "how many engineers do I lead as Software Engineer Manager?" asked by
 * someone who never became a manager. Retrieval reaches real claims about
 * engineers and counts, converges hard, and the reader answers a number. The
 * count is real; the premise is not.
 *
 * Whether making the reader test the premise helps is an empirical question
 * with a cost — it can only trade abstention recall against false abstention on
 * answerable questions — so both variants exist and the eval runs the A/B.
 */
const PremiseAnswer = Schema.Struct({
  answer: Schema.String,
  cited_ids: Schema.Array(Schema.String),
  reasoning: Schema.String,
  /** Every presupposition of the question is supported by the excerpts. */
  premise_supported: Schema.Boolean,
  /** Which presupposition failed, when one did. */
  premise_note: Schema.String
})

export const NOT_IN_MEMORY = "NOT_IN_MEMORY"

const SYSTEM = `You answer a question about one person using only the transcript excerpts given.

The excerpts are verbatim quotes from that person's past conversations with an assistant. Each is
labelled with its date, who was speaking, and whether the memory still considers it CURRENT or
SUPERSEDED by a later statement.

Rules
- Answer ONLY from the excerpts. Do not use anything you know about the world.
- If the excerpts do not contain the answer, reply with exactly ${NOT_IN_MEMORY} as the answer, and
  nothing else. A wrong answer is worse than no answer.
- Prefer CURRENT excerpts. A SUPERSEDED excerpt records what was true earlier, so use it only when
  the question asks what *was* the case, or how something changed.
- Do date arithmetic explicitly in the reasoning field: name the two dates, then give the interval.
  The question's date is given; excerpt dates are the dates of the conversations.
- For a counting question, count the distinct items in the excerpts and say the number.
- Answer in as few words as the question allows — a name, a number, a date, a short phrase. Do not
  restate the question or explain unless the question asks why.
- cited_ids: the ids of the excerpts you actually used. Cite at least one whenever you answer.`

const PREMISE_RULE = `
- Before answering, check every presupposition of the question against the excerpts — that the
  person has the thing, holds the role, did the event, made the purchase. A question can name
  something that never happened and still overlap the excerpts heavily. If a presupposition is
  contradicted by the excerpts, or simply absent from them, set premise_supported to false, name the
  failing presupposition in premise_note, and answer exactly ${NOT_IN_MEMORY}.
- premise_supported: true only when every presupposition holds. premise_note: empty when it does.`

const PREMISE_SYSTEM = SYSTEM + PREMISE_RULE

/**
 * The reader's prompt. Exported so the excerpt-order label can be tested
 * against the order `orderEvidence` actually produces — they disagreed, and
 * exactly on the questions where it mattered.
 */
export const renderReaderPrompt = (
  question: string,
  questionDate: string,
  spans: ReadonlyArray<HydratedSpan>
): string => {
  const body = spans.map((span) => {
    const status =
      span.status === "CURRENT"
        ? "CURRENT"
        : `SUPERSEDED by a later statement (at session ${span.atSession})`
    const dated = span.tEvent > 0 ? `, about ${span.tEvent}` : ""
    return [
      `[${span.id}] session ${span.sessionOrd} on ${span.sessionDate}${dated}, ${span.speaker}, ${status}`,
      span.excerpt
    ].join("\n")
  })

  return [
    `QUESTION DATE: ${questionDate}`,
    `QUESTION: ${question}`,
    "",
    // `orderEvidence` puts CURRENT before SUPERSEDED unless the question is
    // historical, so "oldest first" was wrong exactly when supersession
    // mattered — on the knowledge-update questions. Say what the order is.
    `EXCERPTS (${spans.length}), CURRENT first and then superseded, each group oldest first:`,
    "",
    body.join("\n\n")
  ].join("\n")
}

export interface ReadOptions {
  /**
   * Make the reader test the question's presuppositions before answering.
   * Off by default: it is a measured trade, not a strict improvement, and the
   * numbers for both variants are in `results/table-*.md`.
   */
  readonly premiseCheck?: boolean
}

export interface ReadAnswer {
  readonly answer: string
  readonly notInMemory: boolean
  readonly citedIds: ReadonlyArray<string>
  readonly reasoning: string
  readonly spans: ReadonlyArray<HydratedSpan>
  readonly cached: boolean
  /** Null unless the premise check ran. */
  readonly premiseSupported: boolean | null
  readonly premiseNote: string
  /** What this read cost the provider — the "reader tokens" column of the eval. */
  readonly inputTokens: number
  readonly outputTokens: number
}

const make = Effect.gen(function* () {
  const hydra = yield* HydraClient
  const llm = yield* Llm

  /**
   * Fetches the verbatim turn text behind each evidence Span, in one round
   * trip, by walking the `EVIDENCE` edge each Claim already carries.
   */
  const hydrate = (
    evidence: ReadonlyArray<AsOfLabelled>
  ): Effect.Effect<ReadonlyArray<HydratedSpan>, HydraError> =>
    Effect.gen(function* () {
      if (evidence.length === 0) return []

      const paths = yield* hydra.msPaths({
        sourceLabel: "Claim",
        sourceProperty: "ckey",
        sourceValues: evidence.map((claim) => claim.ckey),
        relTypes: ["EVIDENCE"],
        relDirection: "outgoing",
        maxLen: 1
      })

      const turnText = new Map<string, { text: string; chunks: number }>()
      for (const path of paths) {
        const claim = path.nodes[0]
        const turn = path.nodes[path.nodes.length - 1]
        if (claim === undefined || turn === undefined || claim === turn) continue
        turnText.set(String(claim.properties["ckey"] ?? ""), {
          text: String(turn.properties["text"] ?? ""),
          chunks: Number(turn.properties["chunks"] ?? 1)
        })
      }

      // A turn longer than HydraDB's 32 743-byte string cap spilled into
      // HAS_CHUNK vertices; reassemble only those, and only when the span
      // actually reaches past the first chunk.
      const needsChunks = evidence.filter((claim) => {
        const turn = turnText.get(claim.ckey)
        return turn !== undefined && turn.chunks > 1 && claim.ce > turn.text.length
      })
      if (needsChunks.length > 0) {
        const chunkPaths = yield* hydra.msPaths({
          sourceLabel: "Claim",
          sourceProperty: "ckey",
          sourceValues: needsChunks.map((claim) => claim.ckey),
          relTypes: ["EVIDENCE", "HAS_CHUNK"],
          relDirection: "outgoing",
          maxLen: 2
        })
        const extra = new Map<string, Array<{ idx: number; text: string }>>()
        for (const path of chunkPaths) {
          if (path.relationships.length !== 2) continue
          const ckey = String(path.nodes[0]?.properties["ckey"] ?? "")
          const chunk = path.nodes[2]
          if (chunk === undefined) continue
          const bucket = extra.get(ckey) ?? []
          bucket.push({
            idx: Number(chunk.properties["chunk_idx"] ?? 0),
            text: String(chunk.properties["text"] ?? "")
          })
          extra.set(ckey, bucket)
        }
        for (const [ckey, chunks] of extra) {
          const base = turnText.get(ckey)
          if (base === undefined) continue
          const tail = chunks.sort((a, b) => a.idx - b.idx).map((chunk) => chunk.text).join("")
          turnText.set(ckey, { text: base.text + tail, chunks: base.chunks })
        }
      }

      return evidence.flatMap((claim): ReadonlyArray<HydratedSpan> => {
        const turn = turnText.get(claim.ckey)
        if (turn === undefined) return []
        const cut = cutExcerpt(turn.text, claim.cs, claim.ce)
        return [
          {
            ckey: claim.ckey,
            id: claim.ckey.slice(-8),
            sid: claim.sid,
            sessionOrd: claim.sessionOrd,
            sessionDate: claim.sessionDate,
            tEvent: claim.tEvent,
            speaker: claim.speaker,
            status: claim.status,
            atSession: claim.atSession,
            excerpt: cut.excerpt,
            highlight: cut.highlight
          }
        ]
      })
    })

  /**
   * Reads an answer out of spans that are already in hand.
   *
   * Split from `read` because the baselines need it: BM25 and full-context are
   * only meaningful as comparisons if they face the *same reader prompt* and
   * differ solely in what got selected. Anything that can produce a
   * `HydratedSpan` — the graph, a BM25 ranking over turns, or a whole haystack
   * — can be read the same way.
   */
  const readSpans = (
    question: string,
    questionDate: string,
    spans: ReadonlyArray<HydratedSpan>,
    options: ReadOptions = {}
  ): Effect.Effect<ReadAnswer, never, LanguageModel.LanguageModel | Llm> =>
    Effect.gen(function* () {
      if (spans.length === 0) {
        return {
          answer: NOT_IN_MEMORY,
          notInMemory: true,
          citedIds: [],
          reasoning: "no evidence to read",
          spans,
          cached: true,
          premiseSupported: null,
          premiseNote: "",
          inputTokens: 0,
          outputTokens: 0
        }
      }

      const prompt = renderReaderPrompt(question, questionDate, spans)

      if (options.premiseCheck === true) {
        const generated = yield* llm
          .generateObject({
            kind: "read",
            system: PREMISE_SYSTEM,
            prompt,
            schema: PremiseAnswer,
            objectName: "answer"
          })
          .pipe(Effect.orDie)
        const answer = generated.value.answer.trim()
        return {
          answer,
          // A failed premise *is* a refusal, whatever the answer field says —
          // the two disagree often enough that trusting only the string would
          // undercount the thing being measured.
          notInMemory:
            answer === NOT_IN_MEMORY ||
            answer.startsWith(NOT_IN_MEMORY) ||
            !generated.value.premise_supported,
          citedIds: generated.value.cited_ids,
          reasoning: generated.value.reasoning,
          spans,
          cached: generated.cached,
          premiseSupported: generated.value.premise_supported,
          premiseNote: generated.value.premise_note,
          inputTokens: generated.inputTokens,
          outputTokens: generated.outputTokens
        }
      }

      const generated = yield* llm
        .generateObject({
          kind: "read",
          system: SYSTEM,
          prompt,
          schema: Answer,
          objectName: "answer"
        })
        .pipe(Effect.orDie)

      const answer = generated.value.answer.trim()
      return {
        answer,
        notInMemory: answer === NOT_IN_MEMORY || answer.startsWith(NOT_IN_MEMORY),
        citedIds: generated.value.cited_ids,
        reasoning: generated.value.reasoning,
        spans,
        cached: generated.cached,
        premiseSupported: null,
        premiseNote: "",
        inputTokens: generated.inputTokens,
        outputTokens: generated.outputTokens
      }
    })

  const read = (
    question: string,
    questionDate: string,
    evidence: ReadonlyArray<AsOfLabelled>,
    options: ReadOptions = {}
  ): Effect.Effect<ReadAnswer, HydraError, LanguageModel.LanguageModel | Llm> =>
    Effect.gen(function* () {
      const spans = yield* hydrate(evidence)
      return yield* readSpans(question, questionDate, spans, options)
    })

  return { hydrate, read, readSpans } as const
})

export class Reader extends Effect.Service<Reader>()("palimpsest/Reader", { effect: make }) {}
