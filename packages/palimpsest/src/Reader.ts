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

const renderPrompt = (
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
    `EXCERPTS (${spans.length}), oldest first:`,
    "",
    body.join("\n\n")
  ].join("\n")
}

export interface ReadAnswer {
  readonly answer: string
  readonly notInMemory: boolean
  readonly citedIds: ReadonlyArray<string>
  readonly reasoning: string
  readonly spans: ReadonlyArray<HydratedSpan>
  readonly cached: boolean
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
        const start = Math.max(0, claim.cs - SPAN_CONTEXT)
        const end = Math.min(turn.text.length, claim.ce + SPAN_CONTEXT)
        const excerpt = turn.text.slice(start, end)
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
            excerpt,
            highlight: { start: claim.cs - start, end: Math.min(excerpt.length, claim.ce - start) }
          }
        ]
      })
    })

  const read = (
    question: string,
    questionDate: string,
    evidence: ReadonlyArray<AsOfLabelled>
  ): Effect.Effect<ReadAnswer, HydraError, LanguageModel.LanguageModel | Llm> =>
    Effect.gen(function* () {
      const spans = yield* hydrate(evidence)
      if (spans.length === 0) {
        return {
          answer: NOT_IN_MEMORY,
          notInMemory: true,
          citedIds: [],
          reasoning: "no evidence to read",
          spans,
          cached: true
        }
      }

      const generated = yield* llm
        .generateObject({
          kind: "read",
          system: SYSTEM,
          prompt: renderPrompt(question, questionDate, spans),
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
        cached: generated.cached
      }
    })

  return { hydrate, read } as const
})

export class Reader extends Effect.Service<Reader>()("palimpsest/Reader", { effect: make }) {}
