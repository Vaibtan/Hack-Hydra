import { NodeHttpClient } from "@effect/platform-node"
import { datasetPath } from "@palimpsest/dataset"
import { HydraMemoryLive } from "@palimpsest/hydra"
import { LlmLive } from "@palimpsest/llm"
import { Effect, Layer } from "effect"
import { existsSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { LegacyG3Adapter } from "../../src/LegacyG3Adapter.js"
import { Supersede } from "../../src/Supersede.js"
import { Transcript } from "../../src/Transcript.js"

const hasDataset = existsSync(datasetPath("s"))

const AppLive = LegacyG3Adapter.layer.pipe(
  Layer.provideMerge(Supersede.layer),
  Layer.provideMerge(Transcript.layer),
  Layer.provideMerge(HydraMemoryLive),
  Layer.provideMerge(LlmLive()),
  Layer.provide(NodeHttpClient.layerUndici)
)

const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof AppLive>>) =>
  Effect.runPromise(Effect.provide(effect, AppLive))

const UID = "probe-supersede"
const QUESTION = "What was the amount I was pre-approved for when I got my mortgage from Wells Fargo?"

describe.skipIf(!hasDataset)("retrieval", () => {
  it("answers from converged claims and reaches the answer's session", async () => {
    const result = await run(
      Effect.gen(function* () {
        const legacy = yield* LegacyG3Adapter
        return yield* legacy.retrieve.ask(UID, QUESTION)
      })
    )

    expect(result.verdict).toBe("ANSWER")
    expect(result.reason).toBeNull()
    expect(result.evidence.length).toBeGreaterThan(0)

    expect(result.receipt.query1).toContain("algo.MSpaths")
    expect(result.receipt.query1Paths).toBeGreaterThan(0)
    expect(result.receipt.convergenceThreshold).toBe(2)
    expect(result.receipt.anchorsReachingClaims.length).toBeGreaterThan(1)
    expect(result.receipt.convergence[0]!.convergence).toBeGreaterThanOrEqual(
      result.receipt.convergenceThreshold
    )

    const texts = result.evidence.map((claim) => claim.text).join(" ")
    expect(texts).toContain("$350,000")
    expect(texts).toContain("$400,000")
    const older = result.evidence.find((claim) => claim.text.includes("$350,000"))!
    const newer = result.evidence.find((claim) => claim.text.includes("$400,000"))!
    expect(older.status).toBe("SUPERSEDED")
    expect(newer.status).toBe("CURRENT")

    for (const claim of result.evidence) {
      expect(claim.ce).toBeGreaterThan(claim.cs)
      expect(claim.sid).not.toBe("")
    }
  })

  it("gives the same hash for the same question against the same graph", async () => {
    const [a, b] = await run(
      Effect.gen(function* () {
        const legacy = yield* LegacyG3Adapter
        const first = yield* legacy.retrieve.ask(UID, QUESTION)
        const second = yield* legacy.retrieve.ask(UID, QUESTION)
        return [first, second] as const
      })
    )
    expect(a.hash).toBe(b.hash)
    expect(a.evidence.map((c) => c.ckey)).toEqual(b.evidence.map((c) => c.ckey))
  })

  it("replays an earlier belief with as-of, without a snapshot", async () => {
    const early = await run(
      Effect.gen(function* () {
        const legacy = yield* LegacyG3Adapter
        return yield* legacy.retrieve.ask(UID, QUESTION, { asOf: 4 })
      })
    )
    const texts = early.evidence.map((claim) => claim.text).join(" ")
    expect(texts).toContain("$350,000")
    expect(texts).not.toContain("$400,000")
    expect(early.evidence.every((claim) => claim.sessionOrd <= 4)).toBe(true)
    expect(early.evidence.find((claim) => claim.text.includes("$350,000"))!.status).toBe("CURRENT")
  })

  it("abstains structurally on a question this user never discussed", async () => {
    const absent = await run(
      Effect.gen(function* () {
        const legacy = yield* LegacyG3Adapter
        return yield* legacy.retrieve.ask(
          UID,
          "What did the veterinarian say about my chinchilla's dental surgery?"
        )
      })
    )
    if (absent.verdict === "ABSENT") {
      expect(["A1_no_anchors", "A2_no_convergence"]).toContain(absent.reason)
      expect(absent.evidence).toEqual([])
      expect(absent.receipt.query1).toContain("algo.MSpaths")
    }
    expect(absent.receipt.anchorsReachingNothing.length).toBeGreaterThan(0)
  })
})
