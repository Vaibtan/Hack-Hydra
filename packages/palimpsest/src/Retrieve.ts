import type { LanguageModel } from "@effect/ai"
import {
  HydraClient,
  HydraLimitError,
  renderMsPathsQuery,
  type HydraError,
  type MsPathsConfig
} from "@palimpsest/hydra"
import type { Llm } from "@palimpsest/llm"
import { Duration, Effect } from "effect"
import { createHash } from "node:crypto"
import { questionAnchors, type QuestionAnchors } from "./Anchors.js"
import { claimKind, tokenKey } from "./Keys.js"
import { readUserStats } from "./User.js"
import {
  DEFAULT_TOP_K,
  applyAsOf,
  beforeAsOf,
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
}

/**
 * How many slot-mates of the candidates may join the evidence. Bounded on
 * purpose: a converged claim earned its place, a slot-mate did not, and one
 * broad slot should not decide the reader's token budget.
 */
export const MAX_SLOT_EXPANSION = 40

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
export const READ_TIMEOUT_MS = Number(process.env["PALIMPSEST_READ_TIMEOUT_MS"] ?? 25_000)

const make = Effect.gen(function* () {
  const hydra = yield* HydraClient
  const supersede = yield* Supersede

  const withReadTimeout = <A>(
    stage: string,
    effect: Effect.Effect<A, HydraError>
  ): Effect.Effect<A, HydraError> =>
    Effect.timeoutFail(effect, {
      duration: Duration.millis(READ_TIMEOUT_MS),
      onTimeout: () =>
        new HydraLimitError({
          reason: `retrieval stage ${stage} exceeded ${READ_TIMEOUT_MS} ms`,
          status: 408,
          query: `<ask:${stage}>`
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

  const ask = (
    uid: string,
    question: string,
    options: AskOptions = {}
  ): Effect.Effect<AskResult, HydraError, LanguageModel.LanguageModel | Llm> =>
    Effect.gen(function* () {
      const askStarted = Date.now()
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
          }
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
        }
      }
    })

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
    { readonly claims: ReadonlyArray<ReachedClaim>; readonly query: string | null; readonly paths: number },
    HydraError
  > =>
    Effect.gen(function* () {
      if (skeys.length === 0) return { claims: [], query: null, paths: 0 }

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
      // Scored with zero anchors: these claims did not converge, they were
      // pulled in by their slot, and must never outrank the ones that did.
      return { claims: scoreReached(paths, total).map(withoutConvergence), query: rendered.query, paths: paths.length }
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
    Effect.gen(function* () {
      if (candidates.length === 0) return []
      const paths = yield* hydra.msPaths({
        sourceLabel: "Claim",
        sourceProperty: "ckey",
        sourceValues: candidates.map((claim) => claim.ckey),
        relTypes: ["FILLS"],
        relDirection: "outgoing",
        maxLen: 1
      })
      const skeys = new Set<string>()
      for (const path of paths) {
        const slot = path.nodes[path.nodes.length - 1]
        const skey = String(slot?.properties["skey"] ?? "")
        if (skey !== "") skeys.add(skey)
      }
      return [...skeys].sort()
    })

  return { ask, totalClaims, forgetUser } as const
})

export class Retrieve extends Effect.Service<Retrieve>()("palimpsest/Retrieve", {
  effect: make
}) {}
