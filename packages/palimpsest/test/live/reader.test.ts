import { NodeHttpClient } from "@effect/platform-node"
import { datasetPath } from "@palimpsest/dataset"
import { HydraClient } from "@palimpsest/hydra"
import { LlmLive } from "@palimpsest/llm"
import { Effect, Layer, Option } from "effect"
import { existsSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { NOT_IN_MEMORY, Reader, Retrieve, Supersede, Transcript } from "../../src/index.js"

/**
 * The reader, against the `852ce960` graph built by the supersession test.
 * Ground truth: the user was pre-approved for $350 000 and later $400 000, so
 * the present-tense answer is $400 000 and the as-of-session-4 answer is
 * $350 000 — from the same graph, with no re-ingest.
 */
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
        const result = yield* retrieve.ask(UID, QUESTION)
        const answer = yield* reader.read(QUESTION, DATE, result.evidence)

        // Pull the real turn behind one span and check the excerpt came from it.
        const span = answer.spans[0]!
        const turn = yield* transcript.readTurn(UID, span.sid, result.evidence[0]!.turnIdx)
        return { result, answer, span, turn }
      })
    )

    const { answer, span, turn } = outcome

    expect(answer.notInMemory).toBe(false)
    expect(answer.answer).toContain("400,000")
    expect(answer.citedIds.length).toBeGreaterThan(0)

    // Every excerpt is a literal substring of a stored Turn — never a claim's
    // paraphrase. That is the whole "index over verbatim transcript" claim.
    expect(Option.isSome(turn)).toBe(true)
    expect(Option.getOrThrow(turn).text).toContain(span.excerpt)

    // And the highlight points at the Span inside the excerpt.
    const highlighted = span.excerpt.slice(span.highlight.start, span.highlight.end)
    expect(highlighted.length).toBeGreaterThan(0)
    expect(Option.getOrThrow(turn).text).toContain(highlighted)
  })

  it("answers the earlier value when asked as of an earlier session", async () => {
    const answer = await run(
      Effect.gen(function* () {
        const retrieve = yield* Retrieve
        const reader = yield* Reader
        const result = yield* retrieve.ask(UID, QUESTION, { asOf: 4 })
        return yield* reader.read(QUESTION, DATE, result.evidence)
      })
    )
    // Same graph, same question, different as-of: the memory's earlier belief.
    expect(answer.answer).toContain("350,000")
    expect(answer.answer).not.toContain("400,000")
  })

  it("says NOT_IN_MEMORY rather than guessing when the spans do not hold the answer", async () => {
    const answer = await run(
      Effect.gen(function* () {
        const retrieve = yield* Retrieve
        const reader = yield* Reader
        const question = "What is the registration number of my sailing boat?"
        const result = yield* retrieve.ask(UID, question)
        if (result.verdict === "ABSENT") {
          // Structural abstention: the reader is never reached, which is a
          // different and stronger answer than NOT_IN_MEMORY.
          return { notInMemory: true, structural: true, answer: NOT_IN_MEMORY }
        }
        const read = yield* reader.read(question, DATE, result.evidence)
        return { notInMemory: read.notInMemory, structural: false, answer: read.answer }
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
