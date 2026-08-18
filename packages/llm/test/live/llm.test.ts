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
})
