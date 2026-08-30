import type { LanguageModel } from "@effect/ai"
import {
  HydraClient,
  HydraLimitError,
  renderMsPathsQuery,
  type HydraError,
  type MsPathsConfig
} from "@palimpsest/hydra"
import { Llm, readPathModels, type ReadPathModels } from "@palimpsest/llm"
import { Duration, Effect, Fiber } from "effect"
import { createHash } from "node:crypto"
import { questionAnchors, type QuestionAnchors } from "./Anchors.js"
import {
  convergenceArm,
  convergenceConfig,
  discoveryArm,
  discoverySeeds,
  groupSlotMates,
  probeArm,
  subQuestionArm,
  unionArms,
  type ArmKind,
  type LiveArm
} from "./Arms.js"
import { MAX_KEPT_TURNS, applySelection, orderCandidates, select, shortId } from "./Select.js"
import { applyTimeScope, intervalSentence } from "./TimeScope.js"
import { understand, type Route, type Understood } from "./Understand.js"
import { claimKind, tokenKey } from "./Keys.js"
import { readUserStats } from "./User.js"
import {
  DEFAULT_TOP_K,
  applyAsOf,
  beforeAsOf,
  convergenceThreshold,
  decide,
  orderEvidence,
  rank,
  scoreReached,
  type AsOfLabelled,
  type ReachedClaim,
  type Verdict
} from "./Scoring.js"
import { Supersede } from "./Supersede.js"

/**
 * Retrieval: two bounded round trips and a structural verdict.
 *
 * Query 1 walks from the question's anchors to every Claim of this user, and
 * relevance is *convergence* — how many distinct anchors reached the same
 * claim. Query 2 pulls the full history of the slots those candidates fill, so
 * a knowledge-update question sees the values it replaced as well as the
 * current one. Nothing is queried per claim.
 */

/**
 * The v2 plan, as the receipt records it.
 *
 * Every stage that made a decision says what it decided and on what. A judge
 * replaying an answer should be able to re-derive the evidence set from this
 * alone: which route and why, which arms ran and what each returned, the window
 * that was applied, which rows the selector kept and which it dropped and for
 * what reason.
 */
export interface RetrievalPlan {
  readonly route: Route
  /** `model`, or `cue:<name>` when a deterministic cue overrode the model. */
  readonly routeReason: string
  readonly flags: Understood["flags"]
  readonly subQuestions: ReadonlyArray<string>
  readonly probes: ReadonlyArray<string>
  /** Non-empty only on a refined second pass: the terms sufficiency asked for. */
  readonly extraTerms: ReadonlyArray<string>
  readonly arms: ReadonlyArray<{
    readonly label: string
    readonly kind: string
    readonly claims: number
    readonly paths: number
    readonly query: string | null
    /** The arm exceeded its ceiling and was reported rather than thrown. */
    readonly timedOut: boolean
  }>
  readonly union: { readonly candidates: number; readonly dropped: number }
  readonly timeScope: {
    readonly phrase: string | null
    readonly interval: readonly [number, number] | null
    readonly inScope: number
    readonly outOfScope: number
    readonly applied: boolean
  }
  readonly selection: {
    readonly kept: ReadonlyArray<string>
    readonly dropped: ReadonlyArray<{ readonly id: string; readonly reason: string }>
    readonly reasons: Readonly<Record<string, string>>
    readonly fallback: boolean
  }
  /** What the reader is told the window was, when there is one. */
  readonly intervalSentence: string | null
  /**
   * Which Slot each surviving candidate fills. The pack stage needs it to say
   * which of a Slot's claims was stated last, and a judge needs it to see that
   * two excerpts were about the same thing.
   */
  readonly slots: Readonly<Record<string, string>>
  /**
   * The kept claims the budget may not drop: the probe hits, which are
   * `(entity, attribute)` pairs the question named outright. Losing one to a
   * token budget is losing the thing the question was about.
   */
  readonly protectedKeys: ReadonlyArray<string>
  /**
   * Every session any arm reached, before selection. The error-class table
   * needs it to tell a retrieval miss from a selection miss: if the answer
   * session is here and not in the evidence, the selector dropped it.
   */
  readonly unionSessions: ReadonlyArray<string>
  readonly ablations: Ablations
  /**
   * What the sufficiency stage decided, or `null` on a plan that has not been
   * through it.
   *
   * It is null coming out of `Retrieve.ask` and non-null coming out of
   * `answerV2`, and that is not an oversight: the check reads the *packed*
   * excerpts, which do not exist until after `ask` has returned and `Reader`
   * has hydrated them. #29's receipt box still wants it on the plan, so
   * `answerV2` — the only caller that has both halves — writes it back.
   */
  readonly sufficiency: PlanSufficiency | null
}

/**
 * The sufficiency verdict as the receipt records it.
 *
 * Its own shape rather than `SufficiencyReport` because the receipt records a
 * decision, not a call: `cached` says something about the LLM cache and
 * `missingTerms` is the second pass's input, both of which belong to the run
 * and not to the trace. `tier: "skipped"` is a real value here — a reader of a
 * receipt needs to tell "the check said EXACT" from "the check did not run",
 * and those are the same tier in `SufficiencyReport`.
 */
export interface PlanSufficiency {
  readonly tier: "EXACT" | "INFERRABLE" | "PARTIAL" | "skipped"
  readonly missing: string
  readonly premise: string
  /** Excerpt ids the check cited, after the CURRENT-and-in-pack verification. */
  readonly premiseContradictedBy: ReadonlyArray<string>
  readonly secondPass: boolean
}

/** Everything a judge needs to re-run the read by hand and get the same paths. */
export interface Receipt {
  readonly question: string
  readonly uid: string
  /**
   * Which read path produced this receipt. Recorded from the first v2 commit,
   * before the stages exist, so that no results file is ever ambiguous about
   * which pipeline it came from — including the ones written while v2 still
   * behaves exactly like v1.
   */
  readonly pipeline: Pipeline
  readonly profile: AskProfile
  readonly asOf: number | null
  readonly anchorTerms: ReadonlyArray<string>
  /**
   * The anchors that reached at least one Claim. Named for what it measures:
   * the spec's `A1` is "no anchor *token exists*", and this is "no anchor
   * *reached a claim*", which is the weaker and more useful test — a Token
   * vertex with no HITS edge is indistinguishable from a missing one for the
   * verdict, and the difference would cost a second query to tell apart.
   */
  readonly anchorsReachingClaims: ReadonlyArray<string>
  readonly anchorsReachingNothing: ReadonlyArray<string>
  readonly historical: boolean
  readonly wantsCount: boolean
  readonly timeRef: string | null
  readonly convergenceThreshold: number
  /**
   * The idf denominator: the user's whole-history claim count, *not* the count
   * as of `asOf`. idf only ranks within one question's candidates, so the
   * denominator being from a later epoch shifts every score by the same
   * constant factor and changes no order — but the number in the receipt is the
   * present, and an as-of receipt says so here rather than pretending.
   */
  readonly totalClaims: number
  readonly query1: string
  readonly query1Params: Record<string, string | number>
  readonly query1Paths: number
  readonly query2: string | null
  readonly query2Paths: number
  /**
   * The model ids this read path was configured with.
   *
   * On the receipt and not only in the results envelope, because a receipt is
   * supposed to be replayable on its own: every LLM decision in the read path
   * is cached by content hash, and the hash says nothing about *which model*
   * produced the value behind it. `pipeline` says which of the three were
   * actually called — v1 uses `reader` alone (anchors and the read), v2 uses
   * all three.
   */
  readonly models: ReadPathModels
  /** claim key, convergence, score, anchors — the table behind the decision. */
  readonly convergence: ReadonlyArray<{
    readonly ckey: string
    readonly convergence: number
    readonly score: number
    readonly anchors: ReadonlyArray<string>
  }>
}

export interface AskResult {
  readonly verdict: Verdict["kind"]
  readonly reason: Verdict["reason"]
  readonly evidence: ReadonlyArray<AsOfLabelled>
  readonly receipt: Receipt
  /** sha256 over the sorted evidence keys. Same graph, same question, same hash. */
  readonly hash: string
  readonly anchors: QuestionAnchors
  readonly timings: AskTimings
  /** Null on the v1 pipeline, which has no plan to record. */
  readonly plan: RetrievalPlan | null
}

/**
 * Where an ask spent its time, split so the HydraDB story has an honest number.
 *
 * `graphMs` is the part of the ask that is HydraDB and nothing else — it starts
 * after the anchors call returns and ends when the last read lands, so it never
 * includes an LLM round trip. `askMs` is the whole thing. The two targets are
 * different numbers for a reason: 1.5 s p50 warm is a claim about the index,
 * and 8 s p50 is a claim about the product.
 *
 * Hydration is not in either: it happens in `Reader`, outside `ask`, and the
 * eval adds `ReadAnswer.hydrateMs` to `graphMs` to get the whole graph cost.
 */
export interface AskTimings {
  readonly askMs: number
  readonly graphMs: number
  /** Per-stage wall time. Concurrent stages overlap, so these do not sum to `graphMs`. */
  readonly stages: Readonly<Record<string, number>>
}

/**
 * Which read path an ask takes.
 *
 * `v1` is the shipped pipeline: anchors → convergence → slot expansion →
 * structural verdict. `v2` is the retrieval plan of #22 — understand, arms,
 * scope, select, hydrate/pack, sufficiency, read. Both stay runnable for the
 * whole comparison, on one graph, so every change is a paired result rather
 * than a before-and-after of two different systems.
 *
 * Default `v1` until the adoption gate passes.
 */
export type Pipeline = "v1" | "v2"

/**
 * How much of the plan runs. `fast` drops the sufficiency check and its second
 * pass — the two stages whose cost is an extra LLM round trip — for the demo,
 * where a 5 s answer that is occasionally thinner beats an 8 s one.
 */
export type AskProfile = "full" | "fast"

export interface AskOptions {
  /**
   * The question's own date, verbatim. The anchor prompt already asks the model
   * for a `time_ref` and reads better with it — "last month" is not a search
   * term without one. It is part of the anchors cache key, so threading it
   * re-asks once per question and then costs nothing.
   */
  readonly questionDate?: string
  readonly asOf?: number
  readonly historical?: boolean
  readonly topK?: number
  /** Widening lever from the spec: reach claims through a second Entity hop. */
  readonly maxLen?: number
  readonly pipeline?: Pipeline
  readonly profile?: AskProfile
  /**
   * v2 ablations. Each turns off exactly one stage and nothing else, so a dev
   * run with one flag set measures that stage and not a different pipeline.
   * They are recorded in the results envelope, never defaulted on.
   */
  readonly ablations?: Ablations
  /**
   * Extra anchor terms for a refined second pass.
   *
   * The sufficiency check names what is missing; these are the stems it named.
   * They join the convergence and discovery arms' sources — a second pass is
   * the *same* arms asked a wider question, not a different pipeline, so the
   * only thing that differs between the two passes is what was searched for.
   */
  readonly extraTerms?: ReadonlyArray<string>
}

/**
 * The stages an ablation run can switch off.
 *
 * Off means *skipped*, not "run and ignored": `--no-discovery` must not pay for
 * the round trip it is measuring the value of, and `--no-select` must not pay
 * for the LLM call. Anything else would make the latency column of an ablation
 * table meaningless.
 */
export interface Ablations {
  readonly noDecompose?: boolean
  readonly noDiscovery?: boolean
  readonly noTimeScope?: boolean
  readonly noSelect?: boolean
}

/**
 * How many slot-mates of the candidates may join the evidence. Bounded on
 * purpose: a converged claim earned its place, a slot-mate did not, and one
 * broad slot should not decide the reader's token budget.
 */
export const MAX_SLOT_EXPANSION = 40

/**
 * `2023/04/10 (Mon) 17:50` to `20230410`, the form every date in the graph has.
 *
 * The ask contract takes the dataset's string verbatim because it is part of an
 * LLM cache key; the time scope needs an integer to do arithmetic on. Zero when
 * there is no date, and every stage that would resolve a phrase against it is
 * skipped rather than run against year zero.
 */
export const questionDateInt = (raw?: string): number => {
  if (raw === undefined) return 0
  const match = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/.exec(raw.trim())
  if (match === null) return 0
  return Number(match[1]) * 10_000 + Number(match[2]) * 100 + Number(match[3])
}

export const determinismHash = (ckeys: ReadonlyArray<string>): string =>
  createHash("sha256").update([...ckeys].sort().join("\n"), "utf8").digest("hex")

/**
 * The ceiling on any single HydraDB read an ask makes.
 *
 * Below the engine's own 30 s runtime cap on purpose: the engine's cap
 * protects the *node*, and by the time it fires the caller has already spent
 * 30 s of an 8 s budget. This one protects the ask. A read that trips it fails
 * the ask in v1 — v1 has no arm to lose, only its one convergence walk — and in
 * v2 a timed-out arm is reported in the receipt instead.
 *
 * `PALIMPSEST_READ_TIMEOUT_MS` raises it, which is only ever for *measuring* a
 * read that the ceiling would otherwise hide — a cold convergence walk on a
 * node with its read cache disabled takes far longer than any product budget,
 * and "more than 25 s" is not a number.
 */
export const DEFAULT_READ_TIMEOUT_MS = 25_000

/**
 * Read per call, not once at module load.
 *
 * Every CLI calls `loadDotEnv()` in its body, but ESM evaluates the whole import
 * graph — including this module — *before* the first statement of the entry
 * point runs. A constant initialised from `process.env` here is therefore frozen
 * before the workspace `.env` has been read, and the documented override was
 * silently ignored for exactly the case it exists for: raising the ceiling to
 * measure a cold convergence walk that the ceiling would otherwise hide.
 */
export const readTimeoutMs = (): number => {
  const configured = Number(process.env["PALIMPSEST_READ_TIMEOUT_MS"])
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_READ_TIMEOUT_MS
}

const make = Effect.gen(function* () {
  const hydra = yield* HydraClient
  const supersede = yield* Supersede

  const withReadTimeout = <A>(
    stage: string,
    effect: Effect.Effect<A, HydraError>
  ): Effect.Effect<A, HydraError> =>
    Effect.suspend(() => {
      const ceiling = readTimeoutMs()
      return Effect.timeoutFail(effect, {
        duration: Duration.millis(ceiling),
        onTimeout: () =>
          new HydraLimitError({
            reason: `retrieval stage ${stage} exceeded ${ceiling} ms`,
            status: 408,
            query: `<ask:${stage}>`
          })
      })
    })

  /**
   * `idf` needs the collection size, off the `User` vertex by id in ~100 ms.
   *
   * Memoised per uid for the process lifetime, as #24 asks — but the memo is
   * not what makes the ask fast: this read now runs *concurrently with Query 1*,
   * so on the critical path it costs nothing whether it is cached or not. What
   * the memo buys is one fewer round trip against the node during a batch eval
   * that asks the same user repeatedly.
   *
   * That is also why it has to be forgettable. The memo was removed once before
   * because an ask that follows a live ingest would otherwise score against a
   * stale denominator; the single-session ingest path calls `forgetUser` so
   * that stays true.
   *
   * A user with no `User` vertex is a setup error, not a retrieval outcome —
   * scoring against a total of zero would flatten every idf to 0 and silently
   * change the ranking, so it dies loudly instead.
   */
  const claimTotals = new Map<string, number>()

  const totalClaims = (uid: string): Effect.Effect<number, HydraError> => {
    const memoised = claimTotals.get(uid)
    if (memoised !== undefined) return Effect.succeed(memoised)
    return readUserStats(hydra, uid).pipe(
      Effect.flatMap((stats) =>
        stats._tag === "Some"
          ? Effect.sync(() => {
              claimTotals.set(uid, stats.value.claims)
              return stats.value.claims
            })
          : Effect.dieMessage(
              `user ${uid} has no User vertex — ingest it, or run ` +
                `\`pnpm backfill-user\` if it was ingested before the vertex existed`
            )
      )
    )
  }

  /** Drops the memoised idf denominator after a write to that user. */
  const forgetUser = (uid: string): Effect.Effect<void> =>
    Effect.sync(() => {
      claimTotals.delete(uid)
    })

  /**
   * The shipped pipeline, unchanged.
   *
   * It stays runnable for the whole comparison and is never refactored "while
   * we are in here": every v1 number in the results tables has to be the same
   * number after v2 lands, or the paired test measures two changes at once.
   */
  const askV1 = (
    uid: string,
    question: string,
    options: AskOptions
  ): Effect.Effect<AskResult, HydraError, LanguageModel.LanguageModel | Llm> =>
    Effect.gen(function* () {
      const askStarted = Date.now()
      // On the receipt from here rather than from the results envelope: a
      // receipt has to be replayable on its own, and a content-hash cache key
      // says nothing about which model produced the value behind it.
      const models = readPathModels((yield* Llm).model)
      const stages: Record<string, number> = {}
      /** Wall time of one stage, recorded whether it succeeds or fails. */
      const timed = <A, E, R>(stage: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
        Effect.suspend(() => {
          const started = Date.now()
          return Effect.onExit(effect, () =>
            Effect.sync(() => {
              stages[stage] = Date.now() - started
            })
          )
        })

      const anchors = yield* timed(
        "understand",
        questionAnchors(question, options.questionDate)
      )
      const historical = options.historical ?? anchors.historical
      const topK = options.topK ?? DEFAULT_TOP_K
      // Everything after the anchors call is HydraDB, which is what makes this
      // the number the 1.5 s target is about.
      const graphStarted = Date.now()

      // ---- Query 1: anchors -> claims, one round trip ---------------------
      const config: MsPathsConfig = {
        sourceLabel: "Token",
        sourceProperty: "tkey",
        sourceValues: anchors.terms.map((stem) => tokenKey(uid, stem)),
        targetLabel: "Claim",
        targetProperty: "kind",
        targetValues: [claimKind(uid)],
        relTypes: ["HITS", "NAMES", "MENTIONS"],
        relDirection: "outgoing",
        maxLen: options.maxLen ?? 2
      }
      const rendered = renderMsPathsQuery(config)

      // Level 1. The idf denominator and the convergence walk are independent:
      // `scoreReached` needs both, but neither read needs the other, and they
      // were sequential only because the code was written top to bottom. Both
      // run on the same fiber-local causal token, so a read that follows an
      // ingest still sees it.
      const [total, paths] = yield* Effect.all(
        [
          timed("userStats", totalClaims(uid)),
          timed("convergence", withReadTimeout("convergence", hydra.msPaths(config)))
        ],
        { concurrency: 2 }
      )
      // The as-of cut comes first, so the verdict, the top-K and the receipt
      // all describe the memory as it stood at `k` — not as it stands now with
      // the future filtered out afterwards.
      const reached = beforeAsOf(scoreReached(paths, total), options.asOf)

      // An anchor that reached nothing is indistinguishable from one that does
      // not exist, and for the verdict the difference does not matter: neither
      // contributes convergence. The receipt reports it as unresolved.
      const resolved = new Set(reached.flatMap((claim) => claim.anchors))
      const verdict = decide(reached, resolved.size, topK)

      const receiptBase = {
        question,
        uid,
        // v2's stages land in #26–#31; until they do, `pipeline: "v2"` selects
        // the same reads and produces byte-identical evidence, which is what
        // makes the first paired run a control rather than a measurement.
        pipeline: options.pipeline ?? "v1",
        profile: options.profile ?? "full",
        asOf: options.asOf ?? null,
        anchorTerms: anchors.terms,
        anchorsReachingClaims: [...resolved].sort(),
        anchorsReachingNothing: anchors.terms.filter((stem) => !resolved.has(stem)),
        historical,
        wantsCount: anchors.wantsCount,
        timeRef: anchors.timeRef,
        convergenceThreshold: verdict.threshold,
        totalClaims: total,
        query1: rendered.query,
        query1Params: rendered.parameters,
        query1Paths: paths.length,
        models,
        convergence: rank(reached)
          .slice(0, topK)
          .map((claim) => ({
            ckey: claim.ckey,
            convergence: claim.convergence,
            score: Number(claim.score.toFixed(4)),
            anchors: claim.anchors
          }))
      }

      if (verdict.kind === "ABSENT") {
        return {
          verdict: verdict.kind,
          reason: verdict.reason,
          evidence: [],
          receipt: { ...receiptBase, query2: null, query2Paths: 0 },
          hash: determinismHash([]),
          anchors,
          timings: {
            askMs: Date.now() - askStarted,
            graphMs: Date.now() - graphStarted,
            stages: { ...stages }
          },
          plan: null
        }
      }

      // ---- Query 2: candidate slots -> their whole history ----------------
      // A knowledge-update question has to see the value that was replaced as
      // well as the one that replaced it, and both live in the same Slot.
      //
      // Level 2. The candidates' slot keys and the candidates' supersession
      // edges are both derived from the same set of claim keys and neither
      // needs the other, so they go out together. Reading the edges in two
      // batches — candidates now, slot-mates after Query 2 — is one more round
      // trip than the single merged read it replaces, but it is off the
      // critical path, and `readEdges` folds by *source* claim so two batches
      // and one produce the same map.
      const candidateKeys = verdict.candidates.map((claim) => claim.ckey)
      const [skeys, candidateEdges] = yield* Effect.all(
        [
          timed("slotKeys", withReadTimeout("slotKeys", candidateSlotKeys(verdict.candidates))),
          timed(
            "candidateEdges",
            withReadTimeout("candidateEdges", supersede.readEdges(uid, candidateKeys, options.asOf))
          )
        ],
        { concurrency: 2 }
      )

      // Level 3.
      const slotClaims = yield* timed(
        "slotClaims",
        withReadTimeout("slotClaims", readCandidateSlots(uid, skeys, total))
      )

      const merged = new Map<string, ReachedClaim>()
      for (const claim of verdict.candidates) merged.set(claim.ckey, claim)

      // Slot expansion is bounded. A converged claim earned its place; a
      // slot-mate did not, and one unusually broad slot would otherwise decide
      // how many tokens the reader is asked to read. Newest first, because a
      // slot's recent history is what a question about it usually means.
      const slotMates = slotClaims.claims
        .filter((claim) => !merged.has(claim.ckey))
        .sort((a, b) => b.sessionOrd - a.sessionOrd || a.ckey.localeCompare(b.ckey))
        .slice(0, MAX_SLOT_EXPANSION)
      for (const claim of slotMates) merged.set(claim.ckey, claim)

      // Level 4, and only for the keys the first edge read did not cover.
      const slotMateKeys = slotMates.map((claim) => claim.ckey)
      const slotMateEdges = yield* timed(
        "slotMateEdges",
        withReadTimeout("slotMateEdges", supersede.readEdges(uid, slotMateKeys, options.asOf))
      )
      const edges = new Map([...candidateEdges, ...slotMateEdges])

      const labelled = applyAsOf([...merged.values()], edges, options.asOf)
      const evidence = orderEvidence(labelled, historical)

      return {
        verdict: verdict.kind,
        reason: verdict.reason,
        evidence,
        receipt: {
          ...receiptBase,
          query2: slotClaims.query,
          query2Paths: slotClaims.paths
        },
        hash: determinismHash(evidence.map((claim) => claim.ckey)),
        anchors,
        timings: {
          askMs: Date.now() - askStarted,
          graphMs: Date.now() - graphStarted,
          stages: { ...stages }
        },
        plan: null
      }
    })


  /**
   * The retrieval plan of #22: understand, arms, scope, select, read.
   *
   * The shape is one LLM call to decide *what to look for*, several graph reads
   * that look for it in different ways, a union that remembers which read found
   * what, and one LLM call to decide *what the reader sees*. Everything between
   * the two calls is deterministic given a fixed graph; the two calls themselves
   * are cached by content hash, so a replay is byte-identical and a first run is
   * model-dependent. Everything either call decided is written into the plan on
   * the receipt.
   *
   * The order of the reads is not incidental. `understand` is the only stage in
   * front of the graph, so the idf denominator is fetched *beside* it rather
   * than after it — a read that would otherwise be the first 100 ms of every
   * ask. `graphMs` therefore starts when the understand call returns, and the
   * `userStats` stage it overlaps is reported separately rather than folded in.
   */
  const askV2 = (
    uid: string,
    question: string,
    options: AskOptions
  ): Effect.Effect<AskResult, HydraError, LanguageModel.LanguageModel | Llm> =>
    Effect.gen(function* () {
      const askStarted = Date.now()
      // On the receipt from here rather than from the results envelope: a
      // receipt has to be replayable on its own, and a content-hash cache key
      // says nothing about which model produced the value behind it.
      const models = readPathModels((yield* Llm).model)
      const stages: Record<string, number> = {}
      const timed = <A, E, R>(stage: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
        Effect.suspend(() => {
          const started = Date.now()
          return Effect.onExit(effect, () =>
            Effect.sync(() => {
              stages[stage] = Date.now() - started
            })
          )
        })

      const profile = options.profile ?? "full"
      const maxLen = options.maxLen ?? 2
      const topK = options.topK ?? DEFAULT_TOP_K
      const questionDate = questionDateInt(options.questionDate)

      // The denominator does not depend on the question, so it runs beside the
      // understand call and is off the graph critical path entirely.
      const statsFiber = yield* Effect.fork(timed("userStats", totalClaims(uid)))
      const understood = yield* timed(
        "understand",
        understand(question, questionDate, options.questionDate)
      )
      const graphStarted = Date.now()
      const total = yield* Fiber.join(statsFiber)

      const historical = options.historical ?? understood.historical
      const ablations = options.ablations ?? {}
      const extraTerms = options.extraTerms ?? []
      const terms =
        extraTerms.length === 0
          ? understood.terms
          : [...new Set([...understood.terms, ...extraTerms])].sort()
      const subQuestions = ablations.noDecompose === true ? [] : understood.subQuestions
      // `exactOptionalPropertyTypes` distinguishes an absent key from an
      // `undefined` one, and the union reads it as "no as-of cut" only when it
      // is absent — so an unscoped ask must not pass the key at all.
      const unionOptions = options.asOf === undefined ? {} : { asOf: options.asOf }

      /**
       * An arm that hit the read ceiling is a lost widening, not a failed ask.
       *
       * Only the *optional* arms are caught. The convergence walk is v1's one
       * read: if it cannot complete, the ask has no floor to stand on and fails
       * exactly as v1 fails, rather than quietly returning whatever a probe
       * happened to find. Non-limit errors are never caught here — a 500 from
       * the node is a failure to stop for, not a number to publish.
       */
      const timedOut = new Set<string>()
      const runArm = (
        label: string,
        kind: ArmKind,
        effect: Effect.Effect<LiveArm, HydraError>,
        optional: boolean
      ): Effect.Effect<LiveArm, HydraError> => {
        const measured = timed(label, withReadTimeout(label, effect))
        return optional
          ? Effect.catchTag(measured, "HydraLimitError", () =>
              Effect.sync((): LiveArm => {
                timedOut.add(label)
                return { kind, label, claims: [], query: null, paths: 0, rawPaths: [] }
              })
            )
          : measured
      }

      // ---- the arms ------------------------------------------------------
      // Four at a time. The engine degrades under read concurrency the same way
      // it degraded under write concurrency during the ingest — measured, not
      // assumed — and eleven simultaneous walks from one question would be
      // slower in wall-clock than four, as well as unkind to a concurrent eval.
      const reaching = yield* Effect.all(
        [
          runArm(
            "convergence",
            "convergence",
            convergenceArm(hydra, uid, terms, total, maxLen),
            false
          ),
          ...subQuestions.map((sub, index) =>
            runArm(
              `sub:${index}`,
              "subQuestion",
              subQuestionArm(hydra, uid, sub, index, total, maxLen),
              true
            )
          ),
          ...understood.probes.map((probe) =>
            runArm(
              `probe:${probe.entityCanon}|${probe.attr}`,
              "probe",
              probeArm(hydra, uid, probe, total),
              true
            )
          )
        ],
        { concurrency: 4 }
      )

      // Discovery is serial by construction: its seeds come from what the first
      // walk found, so it costs one more round trip on the critical path. It
      // earns it on exactly the questions v1 loses — the ones whose second fact
      // the question's own words never name.
      const convergence = reaching[0]!
      const firstPass = unionArms(reaching, unionOptions)
      const seeds =
        ablations.noDiscovery === true
          ? []
          : discoverySeeds(
              convergence.rawPaths,
              firstPass.candidates.slice(0, 10),
              new Set(terms)
            )
      const discovery = yield* runArm(
        "discovery",
        "discovery",
        discoveryArm(hydra, uid, seeds, total, maxLen),
        true
      )

      // ---- slot expansion, as v1 does it ---------------------------------
      // Bounded to the top-K candidates rather than the whole union: a
      // slot-mate is not evidence the question was understood, and expanding
      // 120 slots would let one broad slot decide the selector's whole table.
      const reachedArms = [...reaching, discovery]
      const secondPass = unionArms(reachedArms, unionOptions)
      const found = yield* timed(
        "slotKeys",
        withReadTimeout("slotKeys", candidateSlots(secondPass.candidates.slice(0, topK)))
      )
      const slotClaims = yield* timed(
        "slotClaims",
        withReadTimeout("slotClaims", readCandidateSlots(uid, found.skeys, total))
      )
      // Grouped, not a flat forty. v1 took the forty newest slot-mates across
      // every slot, so one slot with a long history - `(me, weight)` on a user
      // who logs it weekly - took the whole allowance and the other slots the
      // question reached contributed nothing. Five per slot spends the same
      // budget across the slots the candidates actually named.
      const slotMates = groupSlotMates(
        slotClaims.claims,
        slotClaims.slotOf,
        new Set(secondPass.candidates.map((candidate) => candidate.ckey)),
        MAX_SLOT_EXPANSION
      )
      const arms: ReadonlyArray<LiveArm> = [
        ...reachedArms,
        {
          kind: "slotMate",
          label: "slotMate",
          claims: slotMates,
          query: slotClaims.query,
          paths: slotClaims.paths,
          rawPaths: []
        }
      ]

      const union = unionArms(arms, unionOptions)
      const slotOf = new Map([...found.slotOf, ...slotClaims.slotOf])

      // Supersession for the whole union, before the selector rather than after
      // it. Reading 120 keys and reading 30 is the same round trip, and doing it
      // here keeps every graph read in one contiguous window — which is the only
      // way `graphMs` can be a claim about HydraDB rather than about OpenAI.
      const edges = yield* timed(
        "edges",
        withReadTimeout(
          "edges",
          supersede.readEdges(
            uid,
            union.candidates.map((candidate) => candidate.ckey),
            options.asOf
          )
        )
      )
      const graphMs = Date.now() - graphStarted

      // ---- scope ---------------------------------------------------------
      // Only when the question carried a date. `understand` resolves the phrase
      // against the question's own date, so with no date there is nothing to
      // resolve it against and any interval it returned would be arithmetic on
      // year zero.
      const interval =
        questionDate > 0 && ablations.noTimeScope !== true ? understood.timeInterval : null
      const scoped = applyTimeScope(union.candidates, interval)

      // ---- the verdict ---------------------------------------------------
      // v1 abstains when nothing converges. v2 keeps that floor for the walks
      // and lets the two arms that did not guess stand on their own: a probe hit
      // is an `(entity, attribute)` the question named outright, and a
      // sub-question hit converged on words the question actually contains.
      // Discovery guessed and a slot-mate came along for the ride, so neither
      // can carry a verdict by itself.
      const resolved = new Set(
        reaching.flatMap((arm) => arm.claims).flatMap((claim) => claim.anchors)
      )
      const threshold = convergenceThreshold(resolved.size)
      const grounded = scoped.claims.filter(
        (candidate) =>
          candidate.kind === "probe" ||
          candidate.kind === "subQuestion" ||
          candidate.convergence >= threshold
      )

      const armRows = arms.map((arm) => ({
        label: arm.label,
        kind: arm.kind as string,
        claims: arm.claims.length,
        paths: arm.paths,
        query: arm.query,
        timedOut: timedOut.has(arm.label)
      }))
      const timeScopeRow = {
        phrase: understood.timeRef,
        interval: interval === null ? null : ([interval.start, interval.end] as const),
        inScope: scoped.inScope,
        outOfScope: scoped.outOfScope,
        applied: scoped.applied
      }

      const rendered = renderMsPathsQuery(convergenceConfig(uid, terms, maxLen))
      const receiptBase = {
        question,
        uid,
        pipeline: "v2" as const,
        profile,
        asOf: options.asOf ?? null,
        anchorTerms: terms,
        anchorsReachingClaims: [...resolved].sort(),
        anchorsReachingNothing: terms.filter((stem) => !resolved.has(stem)),
        historical,
        wantsCount: understood.flags.wantsCount,
        timeRef: understood.timeRef,
        // Recorded, not applied: v2 does not filter by convergence, it selects.
        // The number is here so a v1 and a v2 receipt for the same question can
        // be read side by side.
        convergenceThreshold: threshold,
        totalClaims: total,
        query1: convergence.query ?? rendered.query,
        query1Params: rendered.parameters,
        query1Paths: convergence.paths,
        query2: slotClaims.query,
        query2Paths: slotClaims.paths,
        models,
        convergence: rank(union.candidates)
          .slice(0, topK)
          .map((claim) => ({
            ckey: claim.ckey,
            convergence: claim.convergence,
            score: Number(claim.score.toFixed(4)),
            anchors: claim.anchors
          }))
      }
      const planBase = {
        route: understood.route,
        routeReason: understood.routeReason,
        flags: understood.flags,
        subQuestions: understood.subQuestions.map((sub) => sub.question),
        probes: understood.probes.map((probe) => `${probe.entityCanon}|${probe.attr}`),
        extraTerms,
        arms: armRows,
        union: { candidates: union.candidates.length, dropped: union.dropped.length },
        timeScope: timeScopeRow,
        intervalSentence: interval === null ? null : intervalSentence(interval),
        // Only for the claims that got this far: the whole map is thousands of
        // rows on a broad user, and the receipt is a record of one decision.
        slots: Object.fromEntries(
          union.candidates.flatMap((candidate) => {
            const slot = slotOf.get(candidate.ckey)
            return slot === undefined ? [] : [[candidate.ckey, slot] as const]
          })
        ),
        unionSessions: [...new Set(union.candidates.map((candidate) => candidate.sid))].sort(),
        ablations,
        // Filled in by `answerV2`: the check judges the pack, and the pack does
        // not exist yet here.
        sufficiency: null
      }
      const anchors: QuestionAnchors = {
        terms,
        historical: understood.historical,
        wantsCount: understood.flags.wantsCount,
        timeRef: understood.timeRef,
        expanded: understood.expanded,
        cached: understood.cached
      }

      if (grounded.length === 0) {
        return {
          verdict: "ABSENT" as const,
          reason: resolved.size === 0 ? ("A1_no_anchors" as const) : ("A2_no_convergence" as const),
          evidence: [],
          receipt: receiptBase,
          hash: determinismHash([]),
          anchors,
          timings: { askMs: Date.now() - askStarted, graphMs, stages: { ...stages } },
          plan: {
            ...planBase,
            protectedKeys: [],
            selection: { kept: [], dropped: [], reasons: {}, fallback: false }
          }
        }
      }

      // ---- selection -----------------------------------------------------
      const selection =
        ablations.noSelect === true
          ? {
              kept: orderCandidates(scoped.claims).slice(0, MAX_KEPT_TURNS),
              dropped: [],
              reasons: {},
              fallback: false,
              cached: true
            }
          : yield* timed(
              "select",
              select(
                question,
                options.questionDate ?? String(questionDate),
                understood.route,
                scoped.claims
              )
            )
      // A selector that kept nothing has not made a decision, it has failed
      // quietly — and an empty evidence set reads downstream as "the memory does
      // not contain it", which is a different claim entirely. `applySelection`
      // is that rule, tested without a graph.
      const applied = applySelection(scoped.claims, selection)
      const kept = applied.kept

      const labelled = applyAsOf(kept, edges, options.asOf)
      const evidence = orderEvidence(labelled, historical)

      return {
        verdict: "ANSWER" as const,
        reason: null,
        evidence,
        receipt: receiptBase,
        hash: determinismHash(evidence.map((claim) => claim.ckey)),
        anchors,
        timings: { askMs: Date.now() - askStarted, graphMs, stages: { ...stages } },
        plan: {
          ...planBase,
          protectedKeys: kept
            .filter((candidate) => candidate.kind === "probe")
            .map((candidate) => candidate.ckey),
          selection: {
            kept: kept.map((candidate) => shortId(candidate.ckey)),
            dropped: applied.dropped.map((drop) => ({
              id: shortId(drop.candidate.ckey),
              reason: drop.reason as string
            })),
            reasons: selection.reasons,
            fallback: applied.fallback
          }
        }
      }
    })

  const ask = (
    uid: string,
    question: string,
    options: AskOptions = {}
  ): Effect.Effect<AskResult, HydraError, LanguageModel.LanguageModel | Llm> =>
    (options.pipeline ?? "v1") === "v2" ? askV2(uid, question, options) : askV1(uid, question, options)

  /**
   * Pulls every claim of the given slots. One round trip for any number of
   * slots, because `MSpaths` is driven from the slot keys as source values.
   *
   * The slot keys arrive as an argument rather than being read here, so that
   * the walk that finds them can run alongside the candidates' supersession
   * edges instead of in front of them.
   */
  const readCandidateSlots = (
    uid: string,
    skeys: ReadonlyArray<string>,
    total: number
  ): Effect.Effect<
    {
      readonly claims: ReadonlyArray<ReachedClaim>
      readonly query: string | null
      readonly paths: number
      /** Which Slot each claim fills, for adjudication and slot grouping. */
      readonly slotOf: ReadonlyMap<string, string>
    },
    HydraError
  > =>
    Effect.gen(function* () {
      if (skeys.length === 0) return { claims: [], query: null, paths: 0, slotOf: new Map() }

      const config: MsPathsConfig = {
        sourceLabel: "Slot",
        sourceProperty: "skey",
        sourceValues: skeys,
        targetLabel: "Claim",
        targetProperty: "kind",
        targetValues: [claimKind(uid)],
        relTypes: ["FILLS"],
        relDirection: "incoming",
        maxLen: 1
      }
      const rendered = renderMsPathsQuery(config)
      const paths = yield* hydra.msPaths(config)
      // The walk is Slot -> Claim, so the source node names the Slot the target
      // claim fills. Reading it here costs nothing; asking for it later would
      // be a second identical round trip.
      const slotOf = new Map<string, string>()
      for (const path of paths) {
        const skey = String(path.nodes[0]?.properties["skey"] ?? "")
        const ckey = String(path.nodes[path.nodes.length - 1]?.properties["ckey"] ?? "")
        if (skey !== "" && ckey !== "") slotOf.set(ckey, skey)
      }
      // Scored with zero anchors: these claims did not converge, they were
      // pulled in by their slot, and must never outrank the ones that did.
      return {
        claims: scoreReached(paths, total).map(withoutConvergence),
        query: rendered.query,
        paths: paths.length,
        slotOf
      }
    })

  const withoutConvergence = (claim: ReachedClaim): ReachedClaim => ({
    ...claim,
    anchors: [],
    convergence: 0,
    score: 0
  })

  /** The slots the candidate claims fill, read in one round trip. */
  const candidateSlotKeys = (
    candidates: ReadonlyArray<ReachedClaim>
  ): Effect.Effect<ReadonlyArray<string>, HydraError> =>
    Effect.map(candidateSlots(candidates), (found) => found.skeys)

  /**
   * The same read, keeping which candidate filled which Slot.
   *
   * v1 only ever needed the set of Slot keys to widen into. v2 needs the
   * mapping as well — to group slot-mates by Slot rather than taking a flat
   * forty, and to tell the reader which of a Slot's claims was stated last.
   */
  const candidateSlots = (
    candidates: ReadonlyArray<ReachedClaim>
  ): Effect.Effect<
    { readonly skeys: ReadonlyArray<string>; readonly slotOf: ReadonlyMap<string, string> },
    HydraError
  > =>
    Effect.gen(function* () {
      if (candidates.length === 0) return { skeys: [], slotOf: new Map() }
      const paths = yield* hydra.msPaths({
        sourceLabel: "Claim",
        sourceProperty: "ckey",
        sourceValues: candidates.map((claim) => claim.ckey),
        relTypes: ["FILLS"],
        relDirection: "outgoing",
        maxLen: 1
      })
      const skeys = new Set<string>()
      const slotOf = new Map<string, string>()
      for (const path of paths) {
        const skey = String(path.nodes[path.nodes.length - 1]?.properties["skey"] ?? "")
        const ckey = String(path.nodes[0]?.properties["ckey"] ?? "")
        if (skey === "") continue
        skeys.add(skey)
        if (ckey !== "") slotOf.set(ckey, skey)
      }
      return { skeys: [...skeys].sort(), slotOf }
    })

  return { ask, totalClaims, forgetUser } as const
})

export class Retrieve extends Effect.Service<Retrieve>()("palimpsest/Retrieve", {
  effect: make
}) {}
