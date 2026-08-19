import type { LanguageModel } from "@effect/ai"
import { HydraClient, renderMsPathsQuery, type HydraError, type MsPathsConfig } from "@palimpsest/hydra"
import type { Llm } from "@palimpsest/llm"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import { questionAnchors, type QuestionAnchors } from "./Anchors.js"
import { claimKind, tokenKey } from "./Keys.js"
import {
  DEFAULT_TOP_K,
  applyAsOf,
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
  readonly anchorsResolved: ReadonlyArray<string>
  readonly anchorsUnresolved: ReadonlyArray<string>
  readonly historical: boolean
  readonly wantsCount: boolean
  readonly timeRef: string | null
  readonly convergenceThreshold: number
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
  readonly asOf?: number
  readonly historical?: boolean
  readonly topK?: number
  /** Widening lever from the spec: reach claims through a second Entity hop. */
  readonly maxLen?: number
}

export const determinismHash = (ckeys: ReadonlyArray<string>): string =>
  createHash("sha256").update([...ckeys].sort().join("\n"), "utf8").digest("hex")

const make = Effect.gen(function* () {
  const hydra = yield* HydraClient
  const supersede = yield* Supersede

  /** `idf` needs the collection size; one scan per ask, memoised per user. */
  const claimCounts = new Map<string, number>()
  const totalClaims = (uid: string): Effect.Effect<number, HydraError> =>
    Effect.gen(function* () {
      const cached = claimCounts.get(uid)
      if (cached !== undefined) return cached
      const result = yield* hydra.query(
        "MATCH (c:Claim) WHERE c.uid = $uid RETURN count(*) AS c",
        { uid }
      )
      const count = Number(result.rows[0]?.["c"] ?? 0)
      claimCounts.set(uid, count)
      return count
    })

  const ask = (
    uid: string,
    question: string,
    options: AskOptions = {}
  ): Effect.Effect<AskResult, HydraError, LanguageModel.LanguageModel | Llm> =>
    Effect.gen(function* () {
      const anchors = yield* questionAnchors(question)
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
      const reached = scoreReached(paths, total)

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
        anchorsResolved: [...resolved].sort(),
        anchorsUnresolved: anchors.terms.filter((stem) => !resolved.has(stem)),
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
      for (const claim of slotClaims.claims) {
        if (!merged.has(claim.ckey)) merged.set(claim.ckey, claim)
      }

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
