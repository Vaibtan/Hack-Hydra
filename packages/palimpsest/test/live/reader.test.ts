import { NodeHttpClient } from "@effect/platform-node"
import { datasetPath } from "@palimpsest/dataset"
import { HydraClient } from "@palimpsest/hydra"
import { LlmLive } from "@palimpsest/llm"
import { Effect, Layer, Option } from "effect"
import { existsSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { answerV2 } from "../../src/Answer.js"
import { Reader } from "../../src/Reader.js"
import { Retrieve } from "../../src/Retrieve.js"
import { NOT_IN_MEMORY } from "../../src/Routes.js"
import { Supersede } from "../../src/Supersede.js"
import { Transcript } from "../../src/Transcript.js"

const hasDataset = existsSync(datasetPath("s"))

const AppLive = Retrieve.Default.pipe(
  Layer.provideMerge(Reader.Default),
  Layer.provideMerge(Supersede.Default),
  Layer.provideMerge(Transcript.Default),
  Layer.provideMerge(HydraClient.Default),
  Layer.provideMerge(LlmLive()),
  Layer.provide(NodeHttpClient.layerUndici)
)

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(Effect.provide(effect, AppLive) as unknown as Effect.Effect<A, E, never>)

const UID = "probe-supersede"
const DATE = "2023/05/20 (Sat) 02:21"
const QUESTION = "What was the amount I was pre-approved for when I got my mortgage from Wells Fargo?"

describe.skipIf(!hasDataset)("reader", () => {
  it("answers from verbatim transcript text, not from claim summaries", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const retrieve = yield* Retrieve
        const reader = yield* Reader
        const transcript = yield* Transcript
        const answered = yield* answerV2(retrieve, reader, UID, QUESTION, DATE)
        const result = answered.ask
        const answer = answered.read!

        const span = answer.spans[0]!
        const turn = yield* transcript.readTurn(UID, span.sid, span.turnIdx)
        return { result, answer, span, turn }
      })
    )

    const { answer, span, turn } = outcome

    expect(answer.notInMemory).toBe(false)
    expect(answer.answer).toContain("400,000")
    expect(answer.citedIds.length).toBeGreaterThan(0)

    expect(Option.isSome(turn)).toBe(true)
    expect(Option.getOrThrow(turn).text).toContain(span.excerpt)

    const highlighted = span.excerpt.slice(span.highlight.start, span.highlight.end)
    expect(highlighted.length).toBeGreaterThan(0)
    expect(Option.getOrThrow(turn).text).toContain(highlighted)
  })

  it("answers the earlier value when asked as of an earlier session", async () => {
    const answer = await run(
      Effect.gen(function* () {
        const retrieve = yield* Retrieve
        const reader = yield* Reader
        const answered = yield* answerV2(retrieve, reader, UID, QUESTION, DATE, { asOf: 4 })
        return answered.read!
      })
    )
    expect(answer.answer).toContain("350,000")
    expect(answer.answer).not.toContain("400,000")
  })

  it("says NOT_IN_MEMORY rather than guessing when the spans do not hold the answer", async () => {
    const answer = await run(
      Effect.gen(function* () {
        const retrieve = yield* Retrieve
        const reader = yield* Reader
        const question = "What is the registration number of my sailing boat?"
        const answered = yield* answerV2(retrieve, reader, UID, question, DATE)
        if (answered.read === null) {
          return { notInMemory: true, structural: true, answer: NOT_IN_MEMORY }
        }
        return {
          notInMemory: answered.verdict === "ABSENT" || answered.read.notInMemory,
          structural: false,
          answer: answered.read.answer
        }
      })
    )
    expect(answer.notInMemory).toBe(true)
  })

  it("gives an identical evidence hash on 20 consecutive runs", async () => {
    const hashes = await run(
      Effect.gen(function* () {
        const retrieve = yield* Retrieve
        return yield* Effect.forEach(
          Array.from({ length: 20 }, (_, i) => i),
          () => retrieve.ask(UID, QUESTION).pipe(Effect.map((result) => result.hash)),
          { concurrency: 4 }
        )
      })
    )
    expect(new Set(hashes).size).toBe(1)
  })
})
