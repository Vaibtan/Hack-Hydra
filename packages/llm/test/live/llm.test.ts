import { Effect, Schema } from "effect"
import { rm } from "node:fs/promises"
import { resolve } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { Llm, LlmLive } from "../../src/index.js"
import { usageCostUsd } from "../../src/Llm.js"

/** Against the real account: the model honours a JSON schema, and the second call is free. */
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

    expect(outcome.usageAfterFirst.calls).toBe(1)
    expect(outcome.usageAfterSecond.calls).toBe(1)
    expect(outcome.usageAfterSecond.cacheHits).toBe(1)
    expect(outcome.usageAfterFirst.inputTokens).toBeGreaterThan(0)
    expect(usageCostUsd(outcome.model, outcome.usageAfterSecond)).toBeGreaterThan(0)
  })

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

    expect([...outcome.byModel.keys()].sort()).toContain("gpt-4o")
    expect(outcome.byModel.size).toBe(2)
    expect(outcome.cost).toBeGreaterThan(0)
  })

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
    expect(outcome.second.inputTokens).toBe(outcome.first.inputTokens)
    expect(outcome.second.inputTokens).toBeGreaterThan(0)
  })
})
