import type { LanguageModel } from "@effect/ai"
import { HydraClient, renderMsPathsQuery, type HydraError, type MsPathsConfig } from "@palimpsest/hydra"
import type { Llm } from "@palimpsest/llm"
import { Effect } from "effect"
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
}

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
}

/**
 * How many slot-mates of the candidates may join the evidence. Bounded on
 * purpose: a converged claim earned its place, a slot-mate did not, and one
 * broad slot should not decide the reader's token budget.
 */
export const MAX_SLOT_EXPANSION = 40

export const determinismHash = (ckeys: ReadonlyArray<string>): string =>
  createHash("sha256").update([...ckeys].sort().join("\n"), "utf8").digest("hex")

const make = Effect.gen(function* () {
  const hydra = yield* HydraClient
  const supersede = yield* Supersede

  /**
   * `idf` needs the collection size. It comes off the `User` vertex by id in
   * ~100 ms, and is re-read on every ask rather than memoised: the memo was
   * only ever there to amortise a 4.4 s label scan, and holding it would make
   * an ask that follows a live ingest score against a stale denominator.
   *
   * A user with no `User` vertex is a setup error, not a retrieval outcome —
   * scoring against a total of zero would flatten every idf to 0 and silently
   * change the ranking, so it dies loudly instead.
   */
  const totalClaims = (uid: string): Effect.Effect<number, HydraError> =>
    readUserStats(hydra, uid).pipe(
      Effect.flatMap((stats) =>
        stats._tag === "Some"
          ? Effect.succeed(stats.value.claims)
          : Effect.dieMessage(
              `user ${uid} has no User vertex — ingest it, or run ` +
                `\`pnpm backfill-user\` if it was ingested before the vertex existed`
            )
      )
    )

  const ask = (
    uid: string,
    question: string,
    options: AskOptions = {}
  ): Effect.Effect<AskResult, HydraError, LanguageModel.LanguageModel | Llm> =>
    Effect.gen(function* () {
      const anchors = yield* questionAnchors(question, options.questionDate)
      const historical = options.historical ?? anchors.historical
      const topK = options.topK ?? DEFAULT_TOP_K
      const total = yield* totalClaims(uid)

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
      const paths = yield* hydra.msPaths(config)
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
          anchors
        }
      }

      // ---- Query 2: candidate slots -> their whole history ----------------
      // A knowledge-update question has to see the value that was replaced as
      // well as the one that replaced it, and both live in the same Slot.
      const slotClaims = yield* readCandidateSlots(uid, verdict.candidates, total)

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

      const edges = yield* supersede.readEdges(uid, [...merged.keys()], options.asOf)
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
        anchors
      }
    })

  /**
   * Pulls every claim of the slots the candidates fill. The slot keys are
   * derived from the claims we already have, so this is one more round trip,
   * not one per candidate.
   */
  const readCandidateSlots = (
    uid: string,
    candidates: ReadonlyArray<ReachedClaim>,
    total: number
  ): Effect.Effect<
    { readonly claims: ReadonlyArray<ReachedClaim>; readonly query: string | null; readonly paths: number },
    HydraError
  > =>
    Effect.gen(function* () {
      const skeys = yield* candidateSlotKeys(candidates)
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

  return { ask, totalClaims } as const
})

export class Retrieve extends Effect.Service<Retrieve>()("palimpsest/Retrieve", {
  effect: make
}) {}
