import { HydraMemory, type HydraError } from "@palimpsest/hydra"
import { Llm } from "@palimpsest/llm"
import { Context, Data, Effect, Layer, Option, Ref } from "effect"
import { answerV2, type AnswerOptions, type V2Answer } from "./Answer.js"
import { gather } from "./Gather.js"
import { turnKey } from "./Keys.js"
import { adjudicate, applyBudget, dedupeByTurn } from "./Pack.js"
import {
  abstentionReason,
  determinismHash,
  emptySelection,
  planFromArms,
  selectionRow,
  type AskOptions,
  type AskResult
} from "./Plan.js"
import {
  readSpansCore,
  toHydratedSpan,
  type Granularity,
  type HydratedSpan,
  type ReadAnswer,
  type ReadOptions,
  type ReadSpansOptions,
  type TurnBody
} from "./Reader.js"
import { granularityFor } from "./Routes.js"
import {
  chunksByKey,
  claimChunks,
  evidenceTurns,
  reassemble,
  sessionTurns,
  turnChunks
} from "./Rows.js"
import { applyAsOf, orderEvidence, type AsOfLabelled } from "./Scoring.js"
import { applySelection, enforceSelection, select, shortId } from "./Select.js"
import { Supersede } from "./Supersede.js"
import { Transcript } from "./Transcript.js"
import { readUserStats, warmUser, type UserStats, type WarmReport } from "./User.js"

/**
 * Removal condition: delete this adapter once S16B proves production-path
 * equivalence and the sessions/stats/warm/slot endpoints migrate off the
 * legacy graph. The frozen retrieval-v2 evidence lane keeps using it until
 * its lane is retired; production ask never falls back to it.
 */
export const LEGACY_G3_REMOVAL_CONDITION =
  "Remove after S16B production-path equivalence plus sessions/stats/warm/slot migration."

/** The legacy graph has no materialized user statistics for the requested user. */
export class LegacyG3UserNotFound extends Data.TaggedError("LegacyG3UserNotFound")<{
  readonly uid: string
}> {
  override get message(): string {
    return `legacy g3 user ${this.uid} has no materialized statistics`
  }
}

/** Expected failures from the explicit legacy benchmark/migration lane. */
export type LegacyG3Error = HydraError | LegacyG3UserNotFound

export interface LegacyRetrieve {
  readonly ask: (
    uid: string,
    question: string,
    options?: AskOptions
  ) => Effect.Effect<AskResult, LegacyG3Error, Llm>
  readonly totalClaims: (uid: string) => Effect.Effect<number, LegacyG3Error>
  readonly forgetUser: (uid: string) => Effect.Effect<void>
}

export interface LegacyReader {
  readonly hydrate: (
    evidence: ReadonlyArray<AsOfLabelled>
  ) => Effect.Effect<ReadonlyArray<HydratedSpan>, HydraError>
  readonly read: (
    question: string,
    questionDate: string,
    evidence: ReadonlyArray<AsOfLabelled>,
    options: ReadOptions
  ) => Effect.Effect<ReadAnswer, HydraError, Llm>
  readonly readSpans: (
    question: string,
    questionDate: string,
    spans: ReadonlyArray<HydratedSpan>,
    options?: ReadSpansOptions
  ) => Effect.Effect<ReadAnswer, never, Llm>
}

export interface LegacyG3Telemetry {
  /** Legacy operations served since the adapter was built, by operation name. */
  readonly counts: Effect.Effect<Readonly<Record<string, number>>>
}

export interface LegacyG3AdapterService {
  readonly retrieve: LegacyRetrieve
  readonly reader: LegacyReader
  readonly answer: (
    uid: string,
    question: string,
    questionDate: string,
    options?: AnswerOptions
  ) => Effect.Effect<V2Answer, LegacyG3Error, Llm>
  readonly readSessions: Transcript["readSessions"]
  readonly readTurn: Transcript["readTurn"]
  readonly slotChain: Supersede["chain"]
  readonly slotChains: Supersede["chains"]
  readonly contestedSlots: Supersede["contestedSlots"]
  readonly userStats: (uid: string) => Effect.Effect<Option.Option<UserStats>, HydraError>
  readonly warm: (uid: string) => Effect.Effect<Option.Option<WarmReport>, HydraError>
  readonly telemetry: LegacyG3Telemetry
}

export class LegacyG3Adapter extends Context.Service<LegacyG3Adapter, LegacyG3AdapterService>()(
  "palimpsest/LegacyG3Adapter"
) {
  static readonly layer: Layer.Layer<
    LegacyG3Adapter,
    never,
    HydraMemory | Supersede | Transcript
  > = Layer.effect(
    LegacyG3Adapter,
    Effect.gen(function* () {
      const hydra = yield* HydraMemory
      const supersede = yield* Supersede
      const transcript = yield* Transcript
      const calls = yield* Ref.make<Record<string, number>>({})

      const record = <A, E, R>(
        operation: string,
        effect: Effect.Effect<A, E, R>
      ): Effect.Effect<A, E, R> =>
        Effect.gen(function* () {
          yield* Ref.update(calls, (counts) => ({
            ...counts,
            [operation]: (counts[operation] ?? 0) + 1
          }))
          return yield* effect
        })

      /** The idf denominator, memoised per uid; `forgetUser` drops it after a live ingest. */
      const claimTotals = yield* Ref.make<ReadonlyMap<string, number>>(new Map())

      const totalClaims = (uid: string): Effect.Effect<number, LegacyG3Error> =>
        Effect.gen(function* () {
          const memoised = (yield* Ref.get(claimTotals)).get(uid)
          if (memoised !== undefined) return memoised
          const stats = yield* readUserStats(hydra, uid)
          if (Option.isNone(stats)) return yield* new LegacyG3UserNotFound({ uid })
          yield* Ref.update(claimTotals, (counts) => {
            const next = new Map(counts)
            next.set(uid, stats.value.claims)
            return next
          })
          return stats.value.claims
        })

      const forgetUser = (uid: string): Effect.Effect<void> =>
        Ref.update(claimTotals, (counts) => {
          const next = new Map(counts)
          next.delete(uid)
          return next
        })

      /** Understand, gather the arms, plan, select, label as-of. */
      const ask = (
        uid: string,
        question: string,
        options: AskOptions = {}
      ): Effect.Effect<AskResult, LegacyG3Error, Llm> =>
        Effect.gen(function* () {
          const gathered = yield* gather(hydra, supersede, totalClaims, uid, question, options)
          const planned = planFromArms(gathered)
          const timings = () => ({
            askMs: Date.now() - gathered.askStarted,
            graphMs: gathered.graphMs,
            stages: { ...gathered.clock.stages }
          })

          if (planned.grounded.length === 0) {
            return {
              verdict: "ABSENT" as const,
              reason: abstentionReason(planned),
              evidence: [],
              receipt: planned.receipt,
              hash: determinismHash([]),
              timings: timings(),
              plan: { ...planned.plan, protectedKeys: [], selection: emptySelection }
            }
          }

          const candidates = planned.scoped.claims
          const selection =
            gathered.ablations.noSelect === true
              ? {
                  ...enforceSelection(
                    candidates,
                    new Set(candidates.map((candidate) => shortId(candidate.ckey)))
                  ),
                  reasons: {},
                  cached: true
                }
              : yield* gathered.clock.timed(
                  "select",
                  select(
                    question,
                    options.questionDate ?? String(gathered.questionDate),
                    gathered.understood.route,
                    candidates
                  )
                )
          const applied = applySelection(candidates, selection)
          const evidence = orderEvidence(
            applyAsOf(applied.kept, gathered.edges, options.asOf),
            gathered.historical
          )

          return {
            verdict: "ANSWER" as const,
            reason: null,
            evidence,
            receipt: planned.receipt,
            hash: determinismHash(evidence.map((claim) => claim.ckey)),
            timings: timings(),
            plan: {
              ...planned.plan,
              protectedKeys: applied.kept
                .filter((candidate) => candidate.kind === "probe")
                .map((candidate) => candidate.ckey),
              selection: selectionRow(applied, selection.reasons)
            }
          }
        })

      const uidOf = (ckey: string): string => {
        const at = ckey.indexOf("|c|")
        return at === -1 ? "" : ckey.slice(0, at)
      }

      const evidenceText = (
        evidence: ReadonlyArray<AsOfLabelled>
      ): Effect.Effect<ReadonlyMap<string, TurnBody>, HydraError> =>
        Effect.gen(function* () {
          const { paths } = yield* hydra.discoverPaths({
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
            const { paths: chunkPaths } = yield* hydra.discoverPaths({
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

          const { paths } = yield* hydra.discoverPaths({
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
            const { paths: chunkPaths } = yield* hydra.discoverPaths({
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

      const readSpans = (
        question: string,
        questionDate: string,
        spans: ReadonlyArray<HydratedSpan>,
        options: ReadSpansOptions = {}
      ): Effect.Effect<ReadAnswer, never, Llm> =>
        Effect.gen(function* () {
          const llm = yield* Llm
          return yield* readSpansCore(llm, question, questionDate, spans, options)
        })

      const read = (
        question: string,
        questionDate: string,
        evidence: ReadonlyArray<AsOfLabelled>,
        options: ReadOptions
      ): Effect.Effect<ReadAnswer, HydraError, Llm> =>
        Effect.gen(function* () {
          const packRoute = options.packRoute ?? options.route
          const granularity = granularityFor(packRoute, options.granularity)

          const hydrateStarted = Date.now()
          const hydrated = yield* hydrateAt(evidence, granularity)
          const hydrateMs = Date.now() - hydrateStarted

          const labelled = adjudicate(
            dedupeByTurn(hydrated),
            options.slotOf ?? new Map(),
            packRoute
          )
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

      const retrieve: LegacyRetrieve = {
        ask: (uid, question, options) => record("retrieve.ask", ask(uid, question, options ?? {})),
        totalClaims: (uid) => record("retrieve.totalClaims", totalClaims(uid)),
        forgetUser: (uid) => record("retrieve.forgetUser", forgetUser(uid))
      }

      const reader: LegacyReader = {
        hydrate: (evidence) => record("reader.hydrate", hydrate(evidence)),
        read: (question, questionDate, evidence, options) =>
          record("reader.read", read(question, questionDate, evidence, options)),
        readSpans: (question, questionDate, spans, options) =>
          record("reader.readSpans", readSpans(question, questionDate, spans, options ?? {}))
      }

      return {
        retrieve,
        reader,
        answer: (uid, question, questionDate, options) =>
          record(
            "answer",
            answerV2(
              { ask: (askUid, askQuestion, askOptions) => retrieve.ask(askUid, askQuestion, askOptions) },
              {
                read: (readQuestion, readDate, readEvidence, readOptions) =>
                  reader.read(readQuestion, readDate, readEvidence, readOptions)
              },
              uid,
              question,
              questionDate,
              options ?? {}
            )
          ),
        readSessions: (uid) => record("transcript.readSessions", transcript.readSessions(uid)),
        readTurn: (uid, sid, turnIdx) =>
          record("transcript.readTurn", transcript.readTurn(uid, sid, turnIdx)),
        slotChain: (uid, skey, asOf) =>
          record("supersede.chain", supersede.chain(uid, skey, asOf)),
        slotChains: (uid, skeys, asOf) =>
          record("supersede.chains", supersede.chains(uid, skeys, asOf)),
        contestedSlots: (uid) => record("supersede.contestedSlots", supersede.contestedSlots(uid)),
        userStats: (uid) => record("user.stats", readUserStats(hydra, uid)),
        warm: (uid) => record("user.warm", warmUser(hydra, uid)),
        telemetry: { counts: Ref.get(calls) }
      }
    })
  )
}
