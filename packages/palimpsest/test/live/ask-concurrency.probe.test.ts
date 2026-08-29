import { NodeHttpClient } from "@effect/platform-node"
import { datasetPath, loadDataset, type DatasetQuestion } from "@palimpsest/dataset"
import { HydraClient, type MsPathsConfig } from "@palimpsest/hydra"
import { LlmLive } from "@palimpsest/llm"
import { Effect, Layer } from "effect"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { questionAnchors } from "../../src/Anchors.js"
import { claimKind, tokenKey } from "../../src/Keys.js"
import {
  DEFAULT_TOP_K,
  MAX_SLOT_EXPANSION,
  Retrieve,
  Supersede,
  applyAsOf,
  beforeAsOf,
  decide,
  determinismHash,
  orderEvidence,
  scoreReached,
  type ReachedClaim
} from "../../src/index.js"

/**
 * The concurrency change moved no bytes.
 *
 * #24 turned the v1 read path from five sequential HydraDB round trips into
 * four dependency levels, and split one supersession read into two. Both are
 * supposed to be invisible in the output: `Effect.all` over two independent
 * reads cannot change either result, and `readEdges` folds by *source* claim,
 * so reading the candidates and the slot-mates separately produces the same
 * map as reading them together.
 *
 * "Supposed to" is not evidence. This probe rebuilds the **old sequential
 * order** out of the same public pieces `ask` uses, runs it against the same
 * graph and the same question, and asserts the evidence and the determinism
 * hash come out byte-identical. It is the only form of the check that can be
 * run at all: the pre-change code cannot be pointed at this graph, because the
 * graph did not exist until the client fixes that shipped alongside it.
 *
 * Runs on the dev split, which is the half the whole comparison iterates on.
 */
const hasDataset = existsSync(datasetPath("s"))
const splitPath = resolve(import.meta.dirname, "../../../../data/splits/retrieval-v2.json")
const hasSplit = existsSync(splitPath)

const AppLive = Retrieve.Default.pipe(
  Layer.provideMerge(Supersede.Default),
  Layer.provideMerge(HydraClient.Default),
  Layer.provideMerge(LlmLive()),
  Layer.provide(NodeHttpClient.layerUndici)
)

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(Effect.provide(effect, AppLive) as unknown as Effect.Effect<A, E, never>)

interface Split {
  readonly prefix: string
  readonly dev: ReadonlyArray<string>
}

const split: Split | null = hasSplit
  ? (JSON.parse(readFileSync(splitPath, "utf8")) as Split)
  : null

/** The read path exactly as it was before #24: five reads, strictly in order. */
const sequentialAsk = (uid: string, question: string, questionDate: string) =>
  Effect.gen(function* () {
    const hydra = yield* HydraClient
    const supersede = yield* Supersede
    const retrieve = yield* Retrieve

    const anchors = yield* questionAnchors(question, questionDate)
    const total = yield* retrieve.totalClaims(uid)

    const config: MsPathsConfig = {
      sourceLabel: "Token",
      sourceProperty: "tkey",
      sourceValues: anchors.terms.map((stem) => tokenKey(uid, stem)),
      targetLabel: "Claim",
      targetProperty: "kind",
      targetValues: [claimKind(uid)],
      relTypes: ["HITS", "NAMES", "MENTIONS"],
      relDirection: "outgoing",
      maxLen: 2
    }
    const paths = yield* hydra.msPaths(config)
    const reached = beforeAsOf(scoreReached(paths, total), undefined)
    const resolved = new Set(reached.flatMap((claim) => claim.anchors))
    const verdict = decide(reached, resolved.size, DEFAULT_TOP_K)
    if (verdict.kind === "ABSENT") {
      return { evidence: [] as ReadonlyArray<{ ckey: string }>, hash: determinismHash([]) }
    }

    const slotPaths = yield* hydra.msPaths({
      sourceLabel: "Claim",
      sourceProperty: "ckey",
      sourceValues: verdict.candidates.map((claim) => claim.ckey),
      relTypes: ["FILLS"],
      relDirection: "outgoing",
      maxLen: 1
    })
    const skeys = new Set<string>()
    for (const path of slotPaths) {
      const slot = path.nodes[path.nodes.length - 1]
      const skey = String(slot?.properties["skey"] ?? "")
      if (skey !== "") skeys.add(skey)
    }

    const merged = new Map<string, ReachedClaim>()
    for (const claim of verdict.candidates) merged.set(claim.ckey, claim)

    if (skeys.size > 0) {
      const slotClaimPaths = yield* hydra.msPaths({
        sourceLabel: "Slot",
        sourceProperty: "skey",
        sourceValues: [...skeys].sort(),
        targetLabel: "Claim",
        targetProperty: "kind",
        targetValues: [claimKind(uid)],
        relTypes: ["FILLS"],
        relDirection: "incoming",
        maxLen: 1
      })
      const slotMates = scoreReached(slotClaimPaths, total)
        .map((claim) => ({ ...claim, anchors: [], convergence: 0, score: 0 }))
        .filter((claim) => !merged.has(claim.ckey))
        .sort((a, b) => b.sessionOrd - a.sessionOrd || a.ckey.localeCompare(b.ckey))
        .slice(0, MAX_SLOT_EXPANSION)
      for (const claim of slotMates) merged.set(claim.ckey, claim)
    }

    // The single merged supersession read the concurrent path replaced with two.
    const edges = yield* supersede.readEdges(uid, [...merged.keys()], undefined)
    const evidence = orderEvidence(applyAsOf([...merged.values()], edges, undefined), anchors.historical)
    return { evidence, hash: determinismHash(evidence.map((claim) => claim.ckey)) }
  })

describe.skipIf(!hasDataset || split === null)("v1 evidence survives the concurrency change", () => {
  it("produces byte-identical evidence and hash for every dev question", async () => {
    const questions = await Effect.runPromise(
      loadDataset("s").pipe(Effect.orDie) as Effect.Effect<ReadonlyArray<DatasetQuestion>, never, never>
    )
    const dev = new Set(split!.dev)
    const subjects = questions.filter((question) => dev.has(question.questionId))
    expect(subjects.length).toBe(split!.dev.length)

    const mismatches: Array<string> = []
    let compared = 0

    for (const question of subjects) {
      const uid = `${split!.prefix}-${question.questionId}`
      const questionDate = question.questionDate.raw

      const outcome = await run(
        Effect.gen(function* () {
          const retrieve = yield* Retrieve
          const concurrent = yield* retrieve.ask(uid, question.question, { questionDate })
          const sequential = yield* sequentialAsk(uid, question.question, questionDate)
          return { concurrent, sequential }
        }).pipe(Effect.either)
      )

      // A user that is not in this graph is skipped rather than failed: the
      // population may have been capacity-capped, and that is recorded in the
      // split file, not here.
      if (outcome._tag === "Left") continue
      compared++

      const { concurrent, sequential } = outcome.right
      if (concurrent.hash !== sequential.hash) {
        mismatches.push(
          `${question.questionId}: hash ${concurrent.hash.slice(0, 12)} vs ` +
            `${sequential.hash.slice(0, 12)} (${concurrent.evidence.length} vs ` +
            `${sequential.evidence.length} claims)`
        )
        continue
      }
      const left = concurrent.evidence.map((claim) => `${claim.ckey}|${claim.status}|${claim.atSession}`)
      const right = sequential.evidence.map(
        (claim) => `${claim.ckey}|${(claim as { status?: string }).status}|${(claim as { atSession?: number | null }).atSession}`
      )
      if (left.join("\n") !== right.join("\n")) {
        mismatches.push(`${question.questionId}: same hash, different order or labels`)
      }
    }

    expect(compared).toBeGreaterThan(0)
    expect(mismatches).toEqual([])
  }, 900_000)
})
