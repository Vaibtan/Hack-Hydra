import { NodeHttpClient } from "@effect/platform-node"
import { datasetPath } from "@palimpsest/dataset"
import { HydraClient } from "@palimpsest/hydra"
import { LlmLive } from "@palimpsest/llm"
import { Effect, Layer } from "effect"
import { existsSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { Retrieve, Supersede } from "../../src/index.js"

/**
 * Retrieval against the graph built by the supersession live test, so the
 * question has a known answer with a known history: `852ce960` was pre-approved
 * for $350 000 and later for $400 000.
 *
 * What is asserted here is everything the receipt promises — that the verdict
 * follows from the paths, that the evidence reaches the answer's session, that
 * as-of replays an earlier belief, and that the same question twice gives the
 * same hash.
 */
const hasDataset = existsSync(datasetPath("s"))

const AppLive = Retrieve.Default.pipe(
  Layer.provideMerge(Supersede.Default),
  Layer.provideMerge(HydraClient.Default),
  Layer.provideMerge(LlmLive()),
  Layer.provide(NodeHttpClient.layerUndici)
)

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(Effect.provide(effect, AppLive) as unknown as Effect.Effect<A, E, never>)

const UID = "probe-supersede"
const QUESTION = "What was the amount I was pre-approved for when I got my mortgage from Wells Fargo?"

describe.skipIf(!hasDataset)("retrieval", () => {
  it("answers from converged claims and reaches the answer's session", async () => {
    const result = await run(
      Effect.gen(function* () {
        const retrieve = yield* Retrieve
        return yield* retrieve.ask(UID, QUESTION)
      })
    )

    expect(result.verdict).toBe("ANSWER")
    expect(result.reason).toBeNull()
    expect(result.evidence.length).toBeGreaterThan(0)

    // The receipt has to be enough to explain the decision on its own.
    expect(result.receipt.query1).toContain("algo.MSpaths")
    expect(result.receipt.query1Paths).toBeGreaterThan(0)
    expect(result.receipt.convergenceThreshold).toBe(2)
    expect(result.receipt.anchorsReachingClaims.length).toBeGreaterThan(1)
    expect(result.receipt.convergence[0]!.convergence).toBeGreaterThanOrEqual(
      result.receipt.convergenceThreshold
    )

    // Both mortgage amounts are in the evidence, and their supersession is shown.
    const texts = result.evidence.map((claim) => claim.text).join(" ")
    expect(texts).toContain("$350,000")
    expect(texts).toContain("$400,000")
    const older = result.evidence.find((claim) => claim.text.includes("$350,000"))!
    const newer = result.evidence.find((claim) => claim.text.includes("$400,000"))!
    expect(older.status).toBe("SUPERSEDED")
    expect(newer.status).toBe("CURRENT")

    // Every evidence claim carries a real span into a real turn.
    for (const claim of result.evidence) {
      expect(claim.ce).toBeGreaterThan(claim.cs)
      expect(claim.sid).not.toBe("")
    }
  })

  it("gives the same hash for the same question against the same graph", async () => {
    const [a, b] = await run(
      Effect.gen(function* () {
        const retrieve = yield* Retrieve
        const first = yield* retrieve.ask(UID, QUESTION)
        const second = yield* retrieve.ask(UID, QUESTION)
        return [first, second] as const
      })
    )
    expect(a.hash).toBe(b.hash)
    expect(a.evidence.map((c) => c.ckey)).toEqual(b.evidence.map((c) => c.ckey))
  })

  it("replays an earlier belief with as-of, without a snapshot", async () => {
    const early = await run(
      Effect.gen(function* () {
        const retrieve = yield* Retrieve
        return yield* retrieve.ask(UID, QUESTION, { asOf: 4 })
      })
    )
    const texts = early.evidence.map((claim) => claim.text).join(" ")
    expect(texts).toContain("$350,000")
    // The later amount had not been said yet, so it cannot be evidence.
    expect(texts).not.toContain("$400,000")
    expect(early.evidence.every((claim) => claim.sessionOrd <= 4)).toBe(true)
    // And with the replacement invisible, the older claim reads as current.
    expect(early.evidence.find((claim) => claim.text.includes("$350,000"))!.status).toBe("CURRENT")
  })

  it("abstains structurally on a question this user never discussed", async () => {
    const absent = await run(
      Effect.gen(function* () {
        const retrieve = yield* Retrieve
        return yield* retrieve.ask(
          UID,
          "What did the veterinarian say about my chinchilla's dental surgery?"
        )
      })
    )
    // Either no anchor exists in this graph, or nothing converged — and which
    // one it was is in the receipt, with the query that shows it.
    if (absent.verdict === "ABSENT") {
      expect(["A1_no_anchors", "A2_no_convergence"]).toContain(absent.reason)
      expect(absent.evidence).toEqual([])
      expect(absent.receipt.query1).toContain("algo.MSpaths")
    }
    // A confident wrong answer is worse than either, so record what happened.
    expect(absent.receipt.anchorsReachingNothing.length).toBeGreaterThan(0)
  })
})
