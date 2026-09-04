import type { LanguageModel } from "@effect/ai"
import { HydraClient, type HydraError } from "@palimpsest/hydra"
import { Llm } from "@palimpsest/llm"
import { Effect, Schema } from "effect"
import { turnKey } from "./Keys.js"
import {
  adjudicate,
  applyBudget,
  dedupeByTurn,
  spanHash,
  type BudgetReport,
  type PackLabel
} from "./Pack.js"
import { NOT_IN_MEMORY, RoutePolicy, granularityFor, type Granularity } from "./Routes.js"
import {
  chunksByKey,
  claimChunks,
  evidenceTurns,
  reassemble,
  sessionTurns,
  turnChunks
} from "./Rows.js"
import type { AsOfLabelled } from "./Scoring.js"
import { shortId } from "./Select.js"
import type { Route } from "./Understand.js"

export { NOT_IN_MEMORY, granularityFor, type Granularity } from "./Routes.js"

/** Characters of surrounding turn text given on each side of a Span. */
export const SPAN_CONTEXT = 300

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
  readonly sessionKey: string
  readonly turnIdx: number
  readonly cs: number
  readonly ce: number
  readonly sessionOrd: number
  readonly sessionDate: number
  readonly tEvent: number
  readonly speaker: string
  readonly status: "CURRENT" | "SUPERSEDED"
  readonly atSession: number | null
  /** Verbatim turn text: the span plus context, or the whole turn with its predecessor. */
  readonly excerpt: string
  /** Where the span sits inside `excerpt`. */
  readonly highlight: { readonly start: number; readonly end: number }
  /** The pack label; absent on the baselines, where `renderReaderPrompt` falls back to `status`. */
  readonly label?: PackLabel
}

const Answer = Schema.Struct({
  answer: Schema.String,
  cited_ids: Schema.Array(Schema.String),
  reasoning: Schema.String
})

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

export const renderReaderPrompt = (
  question: string,
  questionDate: string,
  spans: ReadonlyArray<HydratedSpan>
): string => {
  const body = spans.map((span) => {
    const status =
      span.status === "SUPERSEDED"
        ? `SUPERSEDED by a later statement (at session ${span.atSession})`
        : span.label === "EARLIER STATEMENT"
          ? "EARLIER STATEMENT about the same thing"
          : "CURRENT"
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
    `EXCERPTS (${spans.length}), CURRENT first and then superseded, each group oldest first:`,
    "",
    body.join("\n\n")
  ].join("\n")
}

/** The system prompt for one route; `null` is the single base prompt every baseline gets. */
export const systemFor = (route: Route | null): string =>
  route === null ? SYSTEM : `${SYSTEM}\n\nFor this question in particular:\n${RoutePolicy[route].rules}`

export interface ReadOptions {
  readonly route: Route
  /** The route that picks granularity and adjudication when it differs from the rules route (second pass). */
  readonly packRoute?: Route
  /** Drops the rules block from the system prompt only; granularity and adjudication still follow the route. */
  readonly noReaderRoute?: boolean
  readonly granularity?: Granularity
  readonly slotOf?: ReadonlyMap<string, string>
  readonly protectedKeys?: ReadonlySet<string>
  readonly budgetTokens?: number
}

export interface ReadSpansOptions {
  readonly route?: Route | null
  readonly granularity?: Granularity
}

export interface ReadAnswer {
  readonly answer: string
  readonly notInMemory: boolean
  readonly citedIds: ReadonlyArray<string>
  readonly reasoning: string
  readonly spans: ReadonlyArray<HydratedSpan>
  readonly cached: boolean
  readonly inputTokens: number
  readonly outputTokens: number
  /** Wall time of the HydraDB hydration; zero when the spans were already in hand. */
  readonly hydrateMs: number
  readonly readMs: number
  /** sha256 over the hydrated span tuples — session key, turn, char range. */
  readonly spanHash: string
  readonly granularity: Granularity
  /** The budget stage's report, or `null` when the spans were read as given. */
  readonly pack: BudgetReport<HydratedSpan> | null
  /** The first answer cited nothing that exists and the reader was asked again. */
  readonly recited: boolean
}

interface TurnBody {
  readonly text: string
  /** The preceding turn, rendered, at turn granularity; empty at span granularity. */
  readonly prefix: string
}

const toHydratedSpan = (
  claim: AsOfLabelled,
  body: TurnBody,
  granularity: Granularity
): HydratedSpan => {
  const cut =
    granularity === "span"
      ? cutExcerpt(body.text, claim.cs, claim.ce)
      : (() => {
          const excerpt = body.prefix + body.text
          return {
            excerpt,
            highlight: {
              start: Math.min(body.prefix.length + claim.cs, excerpt.length),
              end: Math.min(body.prefix.length + claim.ce, excerpt.length)
            }
          }
        })()
  return {
    ckey: claim.ckey,
    id: shortId(claim.ckey),
    sid: claim.sid,
    sessionKey: claim.sessionKey,
    turnIdx: claim.turnIdx,
    cs: claim.cs,
    ce: claim.ce,
    sessionOrd: claim.sessionOrd,
    sessionDate: claim.sessionDate,
    tEvent: claim.tEvent,
    speaker: claim.speaker,
    status: claim.status,
    atSession: claim.atSession,
    excerpt: cut.excerpt,
    highlight: cut.highlight
  }
}

const uidOf = (ckey: string): string => {
  const at = ckey.indexOf("|c|")
  return at === -1 ? "" : ckey.slice(0, at)
}

const make = Effect.gen(function* () {
  const hydra = yield* HydraClient
  const llm = yield* Llm

  const evidenceText = (
    evidence: ReadonlyArray<AsOfLabelled>
  ): Effect.Effect<ReadonlyMap<string, TurnBody>, HydraError> =>
    Effect.gen(function* () {
      const paths = yield* hydra.msPaths({
        sourceLabel: "Claim",
        sourceProperty: "ckey",
        sourceValues: evidence.map((claim) => claim.ckey),
        relTypes: ["EVIDENCE"],
        relDirection: "outgoing",
        maxLen: 1
      })
      const turns = new Map<string, { text: string; chunks: number }>()
      for (const turn of evidenceTurns(paths)) {
        turns.set(turn.ckey, { text: turn.text, chunks: turn.chunks })
      }

      const needsChunks = evidence.filter((claim) => {
        const turn = turns.get(claim.ckey)
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
        for (const [ckey, chunks] of chunksByKey(claimChunks(chunkPaths))) {
          const base = turns.get(ckey)
          if (base === undefined) continue
          turns.set(ckey, { ...base, text: reassemble(base.text, chunks) })
        }
      }

      return new Map([...turns].map(([ckey, turn]) => [ckey, { text: turn.text, prefix: "" }]))
    })

  const turnText = (
    evidence: ReadonlyArray<AsOfLabelled>
  ): Effect.Effect<ReadonlyMap<string, TurnBody>, HydraError> =>
    Effect.gen(function* () {
      const uid = uidOf(evidence[0]!.ckey)
      const keyOf = (claim: AsOfLabelled, offset = 0): string =>
        turnKey(uid, claim.sessionKey, claim.turnIdx + offset)

      const wanted = new Set<string>()
      for (const claim of evidence) {
        wanted.add(keyOf(claim))
        if (claim.turnIdx > 0) wanted.add(keyOf(claim, -1))
      }

      const paths = yield* hydra.msPaths({
        sourceLabel: "Turn",
        sourceProperty: "turn",
        sourceValues: [...wanted].sort(),
        relTypes: ["HAS_TURN"],
        relDirection: "incoming",
        maxLen: 1
      })
      const turns = new Map<string, { text: string; chunks: number; role: string }>()
      for (const turn of sessionTurns(paths)) {
        turns.set(turn.key, { text: turn.text, chunks: turn.chunks, role: turn.role })
      }

      const spilled = [...turns].filter(([, turn]) => turn.chunks > 1).map(([key]) => key)
      if (spilled.length > 0) {
        const chunkPaths = yield* hydra.msPaths({
          sourceLabel: "Turn",
          sourceProperty: "turn",
          sourceValues: spilled.sort(),
          relTypes: ["HAS_CHUNK"],
          relDirection: "outgoing",
          maxLen: 1
        })
        for (const [key, chunks] of chunksByKey(turnChunks(chunkPaths))) {
          const base = turns.get(key)
          if (base === undefined) continue
          turns.set(key, { ...base, text: reassemble(base.text, chunks) })
        }
      }

      const bodies = new Map<string, TurnBody>()
      for (const claim of evidence) {
        const turn = turns.get(keyOf(claim))
        if (turn === undefined) continue
        const before = claim.turnIdx > 0 ? turns.get(keyOf(claim, -1)) : undefined
        bodies.set(claim.ckey, {
          text: turn.text,
          prefix: before === undefined ? "" : `(${before.role} said) ${before.text}\n\n`
        })
      }
      return bodies
    })

  const hydrateText = (
    evidence: ReadonlyArray<AsOfLabelled>,
    granularity: Granularity
  ): Effect.Effect<ReadonlyMap<string, TurnBody>, HydraError> =>
    evidence.length === 0
      ? Effect.succeed(new Map())
      : granularity === "turn"
        ? turnText(evidence)
        : evidenceText(evidence)

  const hydrateAt = (
    evidence: ReadonlyArray<AsOfLabelled>,
    granularity: Granularity
  ): Effect.Effect<ReadonlyArray<HydratedSpan>, HydraError> =>
    Effect.map(hydrateText(evidence, granularity), (bodies) =>
      evidence.flatMap((claim) => {
        const body = bodies.get(claim.ckey)
        return body === undefined ? [] : [toHydratedSpan(claim, body, granularity)]
      })
    )

  const hydrate = (
    evidence: ReadonlyArray<AsOfLabelled>
  ): Effect.Effect<ReadonlyArray<HydratedSpan>, HydraError> => hydrateAt(evidence, "span")

  const answered = (
    generated: {
      readonly value: { readonly answer: string; readonly reasoning: string }
      readonly cached: boolean
      readonly inputTokens: number
      readonly outputTokens: number
    },
    spans: ReadonlyArray<HydratedSpan>,
    cited: ReadonlyArray<string>,
    recited: boolean,
    readStarted: number,
    granularity: Granularity
  ): ReadAnswer => {
    const answer = generated.value.answer.trim()
    const uncited = recited && cited.length === 0
    return {
      answer: uncited ? NOT_IN_MEMORY : answer,
      notInMemory: uncited || answer === NOT_IN_MEMORY || answer.startsWith(NOT_IN_MEMORY),
      citedIds: cited,
      reasoning: generated.value.reasoning,
      spans,
      cached: generated.cached,
      inputTokens: generated.inputTokens,
      outputTokens: generated.outputTokens,
      hydrateMs: 0,
      readMs: Date.now() - readStarted,
      spanHash: spanHash(spans),
      granularity,
      pack: null,
      recited
    }
  }

  const readSpans = (
    question: string,
    questionDate: string,
    spans: ReadonlyArray<HydratedSpan>,
    options: ReadSpansOptions = {}
  ): Effect.Effect<ReadAnswer, never, LanguageModel.LanguageModel | Llm> =>
    Effect.gen(function* () {
      const readStarted = Date.now()
      const granularity = options.granularity ?? "span"
      if (spans.length === 0) {
        return answered(
          {
            value: { answer: NOT_IN_MEMORY, reasoning: "no evidence to read" },
            cached: true,
            inputTokens: 0,
            outputTokens: 0
          },
          spans,
          [],
          false,
          readStarted,
          granularity
        )
      }

      const prompt = renderReaderPrompt(question, questionDate, spans)
      const system = systemFor(options.route ?? null)
      const first = yield* llm
        .generateObject({ kind: "read", system, prompt, schema: Answer, objectName: "answer" })
        .pipe(Effect.orDie)

      const known = new Set(spans.map((span) => span.id))
      const validOf = (ids: ReadonlyArray<string>): ReadonlyArray<string> =>
        ids.filter((id) => known.has(id))

      let generated = first
      let cited = validOf(first.value.cited_ids)
      let recited = false
      const said = first.value.answer.trim()
      if (cited.length === 0 && said !== NOT_IN_MEMORY && !said.startsWith(NOT_IN_MEMORY)) {
        recited = true
        generated = yield* llm
          .generateObject({
            kind: "read",
            system,
            prompt: `${prompt}\n\nYour previous answer cited no excerpt that exists. Answer again, and
cite at least one id from this list exactly as written: ${[...known].join(", ")}.
If none of them supports an answer, reply ${NOT_IN_MEMORY}.`,
            schema: Answer,
            objectName: "answer"
          })
          .pipe(Effect.orDie)
        cited = validOf(generated.value.cited_ids)
      }

      return answered(generated, spans, cited, recited, readStarted, granularity)
    })

  const read = (
    question: string,
    questionDate: string,
    evidence: ReadonlyArray<AsOfLabelled>,
    options: ReadOptions
  ): Effect.Effect<ReadAnswer, HydraError, LanguageModel.LanguageModel | Llm> =>
    Effect.gen(function* () {
      const packRoute = options.packRoute ?? options.route
      const granularity = granularityFor(packRoute, options.granularity)

      const hydrateStarted = Date.now()
      const hydrated = yield* hydrateAt(evidence, granularity)
      const hydrateMs = Date.now() - hydrateStarted

      const labelled = adjudicate(dedupeByTurn(hydrated), options.slotOf ?? new Map(), packRoute)
      const budgeted = applyBudget(labelled, {
        ...(options.budgetTokens === undefined ? {} : { budget: options.budgetTokens }),
        ...(options.protectedKeys === undefined ? {} : { protectedKeys: options.protectedKeys })
      })

      const answer = yield* readSpans(question, questionDate, budgeted.kept, {
        route: options.noReaderRoute === true ? null : options.route,
        granularity
      })
      return { ...answer, hydrateMs, pack: budgeted }
    })

  return { hydrate, read, readSpans } as const
})

export class Reader extends Effect.Service<Reader>()("palimpsest/Reader", { effect: make }) {}
