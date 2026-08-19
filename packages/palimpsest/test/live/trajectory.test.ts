import { NodeHttpClient } from "@effect/platform-node"
import { datasetPath } from "@palimpsest/dataset"
import { HydraClient } from "@palimpsest/hydra"
import { LlmLive } from "@palimpsest/llm"
import { Effect, Layer } from "effect"
import { existsSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { Reader, Retrieve, Supersede } from "../../src/index.js"

/**
 * The as-of trajectory — the demo's centrepiece.
 *
 * One graph, no re-ingest, no database snapshot: asking the same question as of
 * different sessions replays what the memory believed at each point, because
 * as-of is nothing but `session_ord ≤ k` and `at_session ≤ k`.
 *
 * On `852ce960` the ground truth is a pre-approval of $350 000 stated in
 * session 3 and revised to $400 000 in session 37.
 */
const hasDataset = existsSync(datasetPath("s"))

const AppLive = Retrieve.Default.pipe(
  Layer.provideMerge(Reader.Default),
  Layer.provideMerge(Supersede.Default),
  Layer.provideMerge(HydraClient.Default),
  Layer.provideMerge(LlmLive()),
  Layer.provide(NodeHttpClient.layerUndici)
)

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(Effect.provide(effect, AppLive) as unknown as Effect.Effect<A, E, never>)

const UID = "probe-supersede"
const DATE = "2023/12/20 (Wed) 12:00"
const QUESTION = "What was the amount I was pre-approved for when I got my mortgage from Wells Fargo?"

describe.skipIf(!hasDataset)("as-of trajectory", () => {
  it("replays what the memory believed before, between and after the change", async () => {
    const answers = await run(
      Effect.gen(function* () {
        const retrieve = yield* Retrieve
        const reader = yield* Reader
        return yield* Effect.forEach(
          [1, 10, 38],
          (asOf) =>
            Effect.gen(function* () {
              const result = yield* retrieve.ask(UID, QUESTION, { asOf })
              if (result.verdict === "ABSENT") {
                return { asOf, answer: "ABSENT", evidence: 0 }
              }
              const answer = yield* reader.read(QUESTION, DATE, result.evidence)
              return {
                asOf,
                answer: answer.notInMemory ? "NOT_IN_MEMORY" : answer.answer,
                evidence: result.evidence.length
              }
            }),
          { concurrency: 3 }
        )
      })
    )

    const [before, between, after] = answers

    // Before the fact was ever stated, the memory must not leak a later value.
    expect(before!.answer).not.toContain("350,000")
    expect(before!.answer).not.toContain("400,000")
    expect(["ABSENT", "NOT_IN_MEMORY"]).toContain(before!.answer)

    // Between the two statements, the first value is what was true.
    expect(between!.answer).toContain("350,000")
    expect(between!.answer).not.toContain("400,000")

    // After the revision, the second.
    expect(after!.answer).toContain("400,000")

    // Three distinct beliefs from one graph.
    expect(new Set(answers.map((a) => a.answer)).size).toBe(3)
  })

  it("never shows a claim from a later session in an earlier reading", async () => {
    const evidence = await run(
      Effect.gen(function* () {
        const retrieve = yield* Retrieve
        const result = yield* retrieve.ask(UID, QUESTION, { asOf: 10 })
        return result.evidence
      })
    )
    expect(evidence.length).toBeGreaterThan(0)
    expect(evidence.every((claim) => claim.sessionOrd <= 10)).toBe(true)
    // And with the replacement not yet written, nothing reads as superseded by it.
    expect(evidence.every((claim) => claim.atSession === null || claim.atSession <= 10)).toBe(true)
  })
})
