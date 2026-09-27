import { HydraMemory } from "@palimpsest/hydra"
import { Llm } from "@palimpsest/llm"
import { Context, Effect, Layer, Option, Result, Schema } from "effect"
import {
  adjudicate,
  applyBudget,
  dedupeByTurn,
  spanHash,
  type BudgetReport,
  type PackLabel
} from "./Pack.js"
import {
  NOT_IN_MEMORY,
  RoutePolicy,
  granularityFor,
  type Granularity
} from "./Routes.js"
import { reassemble } from "./Rows.js"
import type { AsOfLabelled } from "./Scoring.js"
import { candidateId } from "./Select.js"
import type { Route } from "./Understand.js"
import {
  SnapshotGraphMismatch,
  type QueryContext,
  type SpanProvenance
} from "./QueryContext.js"
import { snapshotEvidenceConfig, type SnapshotReadError } from "./SnapshotArms.js"
import {
  parseSnapshotSourceTurn,
  requireSnapshotProvenance,
  snapshotEvidenceLocators,
  type SnapshotEvidenceLocator,
  type SnapshotSourceTurn
} from "./SnapshotRows.js"
import { sourceTurnChunkKey, sourceTurnKey } from "./SourceTranscript.js"

export { NOT_IN_MEMORY, granularityFor, type Granularity } from "./Routes.js"

/** Characters of surrounding turn text given on each side of a Span. */
export const SPAN_CONTEXT = 300

interface ExcerptCut {
  readonly excerpt: string
  readonly highlight: { readonly start: number; readonly end: number }
}

export const cutExcerpt = (
  text: string,
  cs: number,
  ce: number,
  context = SPAN_CONTEXT
): ExcerptCut => {
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
  /** Short, stable id the reader cites — the claim key's tail, or the lane's assigned id. */
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
  /** Present on snapshot spans only; stripped from public evidence by the server projection. */
  readonly provenance?: SpanProvenance
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

export interface TurnBody {
  readonly text: string
  /** The preceding turn, rendered, at turn granularity; empty at span granularity. */
  readonly prefix: string
}

export const toHydratedSpan = (
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
    id: candidateId(claim),
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

export interface GeneratedAnswer {
  readonly value: { readonly answer: string; readonly reasoning: string }
  readonly cached: boolean
  readonly inputTokens: number
  readonly outputTokens: number
}

/** Shared by both lanes: the legacy adapter answers from the spans it hydrated. */
export const answered = (
  generated: GeneratedAnswer,
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

/** The span-reading core both lanes share: citations are validated against the spans in hand. */
export const readSpansCore = (
  llm: Llm,
  question: string,
  questionDate: string,
  spans: ReadonlyArray<HydratedSpan>,
  options: ReadSpansOptions = {}
): Effect.Effect<ReadAnswer, never, Llm> =>
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

interface SnapshotHydration {
  readonly bodies: ReadonlyMap<string, TurnBody>
  readonly locators: ReadonlyMap<string, SnapshotEvidenceLocator>
}

/**
 * Snapshot hydration: resolve each bound evidence claim to its stored source
 * turn through the snapshot's evidence locators, then read the source turns
 * (and predecessors) directly. Unreachable claims drop like the legacy lane;
 * anything disagreeing with the bound snapshot fails the request.
 */
const snapshotHydrateText = (
  hydra: HydraMemory,
  query: QueryContext,
  evidence: ReadonlyArray<AsOfLabelled>,
  granularity: Granularity
): Effect.Effect<SnapshotHydration, SnapshotReadError> =>
  Effect.gen(function* () {
    if (evidence.length === 0) return { bodies: new Map(), locators: new Map() }
    const bound = requireSnapshotProvenance(evidence, query)
    if (Result.isFailure(bound)) return yield* Effect.fail(bound.failure)

    const { paths } = yield* hydra.discoverPaths(snapshotEvidenceConfig(evidence.map((claim) => claim.ckey)))
    const parsed = snapshotEvidenceLocators(paths, query)
    if (Result.isFailure(parsed)) return yield* Effect.fail(parsed.failure)
    const locators = new Map(parsed.success.map((locator) => [locator.ckey, locator]))

    const assigned: Array<{ readonly claim: AsOfLabelled; readonly locator: SnapshotEvidenceLocator }> = []
    for (const claim of bound.success) {
      const locator = locators.get(claim.ckey)
      if (locator === undefined) continue
      const provenance = claim.provenance
      if (
        provenance === undefined ||
        provenance.commitId !== locator.commitId ||
        provenance.sourceDigest !== locator.sourceDigest ||
        provenance.logicalSessionId !== locator.logicalSessionId ||
        claim.turnIdx !== locator.turnIdx ||
        locator.sourceTurnKey !==
          sourceTurnKey(query.scope, locator.logicalSessionId, locator.sourceDigest, locator.turnIdx)
      ) {
        return yield* Effect.fail(
          new SnapshotGraphMismatch({
            snapshotId: query.snapshot.id,
            reason: "evidenceMismatch",
            detail: claim.ckey
          })
        )
      }
      assigned.push({ claim, locator })
    }

    const readTurn = (
      locator: SnapshotEvidenceLocator,
      turnIdx: number,
      turnKey: string
    ): Effect.Effect<SnapshotSourceTurn | undefined, SnapshotReadError> =>
      Effect.gen(function* () {
        const found = yield* hydra.resolveNode({
          label: "SourceTurn",
          key: turnKey,
          properties: ["tenant", "uid", "logical_session_id", "source_digest", "turn_idx", "role", "text", "chunks"]
        })
        if (Option.isNone(found)) return undefined
        const parsedTurn = parseSnapshotSourceTurn(turnKey, found.value, query, {
          logicalSessionId: locator.logicalSessionId,
          sourceDigest: locator.sourceDigest
        })
        if (Result.isFailure(parsedTurn)) return yield* Effect.fail(parsedTurn.failure)
        const turn = parsedTurn.success
        if (turn.turnIdx !== turnIdx) {
          return yield* Effect.fail(
            new SnapshotGraphMismatch({
              snapshotId: query.snapshot.id,
              reason: "sourceTurnMismatch",
              detail: `${turnKey}: turn_idx`
            })
          )
        }
        return turn
      })

    const readFullTurn = (
      locator: SnapshotEvidenceLocator,
      turnIdx: number,
      turnKey: string
    ): Effect.Effect<{ readonly text: string; readonly role: string } | undefined, SnapshotReadError> =>
      Effect.gen(function* () {
        const found = yield* hydra.resolveNode({
          label: "SourceTurn",
          key: turnKey,
          properties: ["tenant", "uid", "logical_session_id", "source_digest", "turn_idx", "role", "text", "chunks"]
        })
        if (Option.isNone(found)) return undefined
        const parsedTurn = parseSnapshotSourceTurn(turnKey, found.value, query, {
          logicalSessionId: locator.logicalSessionId,
          sourceDigest: locator.sourceDigest
        })
        if (Result.isFailure(parsedTurn)) return yield* Effect.fail(parsedTurn.failure)
        const turn = parsedTurn.success
        if (turn.turnIdx !== turnIdx) {
          return yield* Effect.fail(
            new SnapshotGraphMismatch({
              snapshotId: query.snapshot.id,
              reason: "sourceTurnMismatch",
              detail: `${turnKey}: turn_idx`
            })
          )
        }
        if (turn.chunks <= 1) return { text: turn.text, role: turn.role }
        const chunks = yield* Effect.forEach(
          Array.from({ length: turn.chunks - 1 }, (_, index) => index + 1),
          (chunkIdx) =>
            hydra.resolveNode({
              label: "SourceTurnChunk",
              key: sourceTurnChunkKey(
                query.scope,
                locator.logicalSessionId,
                locator.sourceDigest,
                turnIdx,
                chunkIdx
              ),
              properties: ["chunk_idx", "text"]
            }),
          { concurrency: 4 }
        )
        return {
          text: reassemble(
            turn.text,
            chunks.flatMap((chunk, position) =>
              Option.isNone(chunk)
                ? []
                : [{ key: turnKey, idx: Number(chunk.value.properties["chunk_idx"] ?? position + 1), text: String(chunk.value.properties["text"] ?? "") }]
            )
          ),
          role: turn.role
        }
      })

    const bodies = new Map<string, TurnBody>()
    yield* Effect.forEach(
      assigned,
      ({ claim, locator }) =>
        Effect.gen(function* () {
          const stored = yield* readTurn(locator, locator.turnIdx, locator.sourceTurnKey)
          if (stored === undefined) return
          let text = stored.text
          if ((granularity === "turn" || claim.ce > text.length) && stored.chunks > 1) {
            const full = yield* readFullTurn(locator, locator.turnIdx, locator.sourceTurnKey)
            if (full !== undefined) text = full.text
          }
          let prefix = ""
          if (granularity === "turn" && locator.turnIdx > 0) {
            const before = yield* readFullTurn(
              locator,
              locator.turnIdx - 1,
              sourceTurnKey(
                query.scope,
                locator.logicalSessionId,
                locator.sourceDigest,
                locator.turnIdx - 1
              )
            )
            if (before !== undefined) prefix = `(${before.role} said) ${before.text}\n\n`
          }
          bodies.set(claim.ckey, { text, prefix })
        }),
      { concurrency: 4 }
    )
    return { bodies, locators }
  })

const toSnapshotHydratedSpan = (
  claim: AsOfLabelled,
  body: TurnBody,
  granularity: Granularity,
  locator: SnapshotEvidenceLocator,
  query: QueryContext
): HydratedSpan => ({
  ...toHydratedSpan(claim, body, granularity),
  provenance: {
    snapshotId: query.snapshot.id,
    commitId: locator.commitId,
    sourceDigest: locator.sourceDigest,
    logicalSessionId: locator.logicalSessionId,
    sourceTurnKey: locator.sourceTurnKey
  }
})

const make = Effect.gen(function* () {
  const hydra = yield* HydraMemory
  const llm = yield* Llm

  const hydrateAt = (
    query: QueryContext,
    evidence: ReadonlyArray<AsOfLabelled>,
    granularity: Granularity
  ): Effect.Effect<ReadonlyArray<HydratedSpan>, SnapshotReadError> =>
    Effect.map(snapshotHydrateText(hydra, query, evidence, granularity), ({ bodies, locators }) =>
      evidence.flatMap((claim) => {
        const body = bodies.get(claim.ckey)
        const locator = locators.get(claim.ckey)
        return body === undefined || locator === undefined
          ? []
          : [toSnapshotHydratedSpan(claim, body, granularity, locator, query)]
      }))

  const hydrate = (
    query: QueryContext,
    evidence: ReadonlyArray<AsOfLabelled>
  ): Effect.Effect<ReadonlyArray<HydratedSpan>, SnapshotReadError> =>
    hydrateAt(query, evidence, "span")

  const readSpans = (
    question: string,
    questionDate: string,
    spans: ReadonlyArray<HydratedSpan>,
    options: ReadSpansOptions = {}
  ): Effect.Effect<ReadAnswer, never, Llm> => readSpansCore(llm, question, questionDate, spans, options)

  const read = (
    query: QueryContext,
    question: string,
    questionDate: string,
    evidence: ReadonlyArray<AsOfLabelled>,
    options: ReadOptions
  ): Effect.Effect<ReadAnswer, SnapshotReadError, Llm> =>
    Effect.gen(function* () {
      const packRoute = options.packRoute ?? options.route
      const granularity = granularityFor(packRoute, options.granularity)

      const hydrateStarted = Date.now()
      const hydrated = yield* hydrateAt(query, evidence, granularity)
      const hydrateMs = Date.now() - hydrateStarted

      const labelled = adjudicate(dedupeByTurn(hydrated), options.slotOf ?? new Map(), packRoute)
      const budgeted = applyBudget(labelled, {
        ...(options.budgetTokens !== undefined && { budget: options.budgetTokens }),
        ...(options.protectedKeys !== undefined && { protectedKeys: options.protectedKeys })
      })

      const answer = yield* readSpans(question, questionDate, budgeted.kept, {
        route: options.noReaderRoute === true ? null : options.route,
        granularity
      })
      return { ...answer, hydrateMs, pack: budgeted }
    })

  return { hydrate, read, readSpans } as const
})

export type Reader = Effect.Success<typeof make>
const ReaderTag = Context.Service<Reader>("palimpsest/Reader")
export const Reader = Object.assign(ReaderTag, { layer: Layer.effect(ReaderTag, make) })
