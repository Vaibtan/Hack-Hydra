import { NodeHttpClient } from "@effect/platform-node"
import { datasetPath } from "@palimpsest/dataset"
import { HydraMemoryLive } from "@palimpsest/hydra"
import { LlmLive } from "@palimpsest/llm"
import { Effect, Layer } from "effect"
import { existsSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { answerV2 } from "../../src/Answer.js"
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
const DATE = "2023/12/20 (Wed) 12:00"
const QUESTION = "What was the amount I was pre-approved for when I got my mortgage from Wells Fargo?"

describe.skipIf(!hasDataset)("as-of trajectory", () => {
  it("replays what the memory believed before, between and after the change", async () => {
    const answers = await run(
      Effect.gen(function* () {
        const legacy = yield* LegacyG3Adapter
        return yield* Effect.forEach(
          [1, 10, 38],
          (asOf) =>
            Effect.gen(function* () {
              const answered = yield* answerV2(legacy.retrieve, legacy.reader, UID, QUESTION, DATE, { asOf })
              if (answered.read === null || answered.verdict === "ABSENT") {
                return { asOf, answer: "ABSENT", evidence: answered.ask.evidence.length }
              }
              return {
                asOf,
                answer: answered.read.notInMemory ? "NOT_IN_MEMORY" : answered.read.answer,
                evidence: answered.ask.evidence.length
              }
            }),
          { concurrency: 3 }
        )
      })
    )

    const [before, between, after] = answers

    expect(before!.answer).not.toContain("350,000")
    expect(before!.answer).not.toContain("400,000")
    expect(["ABSENT", "NOT_IN_MEMORY"]).toContain(before!.answer)

    expect(between!.answer).toContain("350,000")
    expect(between!.answer).not.toContain("400,000")

    expect(after!.answer).toContain("400,000")

    expect(new Set(answers.map((a) => a.answer)).size).toBe(3)
  })

  it("never shows a claim from a later session in an earlier reading", async () => {
    const evidence = await run(
      Effect.gen(function* () {
        const legacy = yield* LegacyG3Adapter
        const result = yield* legacy.retrieve.ask(UID, QUESTION, { asOf: 10 })
        return result.evidence
      })
    )
    expect(evidence.length).toBeGreaterThan(0)
    expect(evidence.every((claim) => claim.sessionOrd <= 10)).toBe(true)
    expect(evidence.every((claim) => claim.atSession === null || claim.atSession <= 10)).toBe(true)
  })
})
