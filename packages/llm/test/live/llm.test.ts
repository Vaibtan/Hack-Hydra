import { Effect, Schema } from "effect"
import { rm } from "node:fs/promises"
import { resolve } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { Llm, LlmLive, usageCostUsd } from "../../src/index.js"

/**
 * Against the real account. Two facts matter and neither can be mocked: the
 * configured model actually honours a JSON schema, and the second call for the
 * same prompt costs nothing.
 */
const CACHE_DIR = resolve(import.meta.dirname, "..", "..", ".cache-test")
process.env["PALIMPSEST_LLM_CACHE"] = CACHE_DIR

const Capital = Schema.Struct({
  city: Schema.String,
  country: Schema.String,
  founded_before_1500: Schema.Boolean
})

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(Effect.provide(effect, LlmLive()) as unknown as Effect.Effect<A, E, never>)

afterAll(() => rm(CACHE_DIR, { recursive: true, force: true }))

describe("Llm", () => {
  it("returns a schema-validated object and serves the second call from disk", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const llm = yield* Llm
        const options = {
          kind: "test",
          system: "You answer with facts only.",
          prompt: "What is the capital of France?",
          schema: Capital,
          objectName: "capital"
        }
        const first = yield* llm.generateObject(options)
        const usageAfterFirst = yield* llm.usage
        const second = yield* llm.generateObject(options)
        const usageAfterSecond = yield* llm.usage
        return { first, second, usageAfterFirst, usageAfterSecond, model: llm.model }
      })
    )

    expect(outcome.first.value.city.toLowerCase()).toContain("paris")
    expect(outcome.first.cached).toBe(false)
    expect(outcome.second.cached).toBe(true)
    expect(outcome.second.value).toEqual(outcome.first.value)

    // The cached call must not have cost anything.
    expect(outcome.usageAfterFirst.calls).toBe(1)
    expect(outcome.usageAfterSecond.calls).toBe(1)
    expect(outcome.usageAfterSecond.cacheHits).toBe(1)
    expect(outcome.usageAfterFirst.inputTokens).toBeGreaterThan(0)
    expect(usageCostUsd(outcome.model, outcome.usageAfterSecond)).toBeGreaterThan(0)
  })

  /**
   * The eval harness reads with `gpt-5.6-luna` and judges with `gpt-4o` in one
   * process, and a judge scored by the model under test would not be a judge.
   * The override has to reach the provider, not just the cache key.
   */
  it("sends one call to a different model, cached separately", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const llm = yield* Llm
        const options = {
          kind: "test",
          system: "You answer with facts only.",
          prompt: "What is the capital of Portugal?",
          schema: Capital,
          objectName: "capital"
        }
        const judge = yield* llm.generateObject({ ...options, model: "gpt-4o" })
        const again = yield* llm.generateObject({ ...options, model: "gpt-4o" })
        // Same prompt, default model: a different cache entry, so a live call.
        const reader = yield* llm.generateObject(options)
        const byModel = yield* llm.usageByModel
        return { judge, again, reader, byModel, cost: yield* llm.costUsd }
      })
    )

    expect(outcome.judge.model).toBe("gpt-4o")
    expect(outcome.judge.value.city.toLowerCase()).toContain("lisbon")
    expect(outcome.again.cached).toBe(true)
    expect(outcome.reader.model).not.toBe("gpt-4o")
    expect(outcome.reader.cached).toBe(false)

    // Two models, two prices — a single total would be wrong on one of them.
    expect([...outcome.byModel.keys()].sort()).toContain("gpt-4o")
    expect(outcome.byModel.size).toBe(2)
    expect(outcome.cost).toBeGreaterThan(0)
  })

  /**
   * The LongMemEval judge templates end "Answer yes or no only" and upstream
   * scores whether "yes" appears in the lowercased reply. Forcing that through
   * a JSON schema would change what is being measured.
   */
  it("returns free text, and replays it from disk", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const llm = yield* Llm
        const options = {
          kind: "test",
          prompt: "Is Lisbon the capital of Portugal? Answer yes or no only."
        }
        const first = yield* llm.generateText(options)
        const second = yield* llm.generateText(options)
        return { first, second }
      })
    )

    expect(outcome.first.value.toLowerCase()).toContain("yes")
    expect(outcome.first.cached).toBe(false)
    expect(outcome.second.cached).toBe(true)
    expect(outcome.second.value).toBe(outcome.first.value)
    // A cache hit still reports what the call cost, so a results row can carry
    // its own token count on a $0 re-run.
    expect(outcome.second.inputTokens).toBe(outcome.first.inputTokens)
    expect(outcome.second.inputTokens).toBeGreaterThan(0)
  })
})
