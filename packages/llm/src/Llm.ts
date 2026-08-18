import { LanguageModel, type AiError } from "@effect/ai"
import { Config, Effect, JSONSchema, Ref, Schedule, Schema } from "effect"
import { cacheKey, defaultCacheDir, readCache, writeCache } from "./Cache.js"

/**
 * The one seam onto the LLM.
 *
 * Everything above this line asks for a *typed value*, not a completion: the
 * schema constrains the provider's structured output and then validates what
 * came back. Every call is cached on disk by model + system + prompt + schema,
 * so a second run of any experiment makes zero API calls and produces exactly
 * the same graph — which is what lets the pitch say "deterministic given a
 * fixed graph" honestly.
 */

/** Token prices in USD per million tokens. */
export const PRICING: Record<string, { readonly input: number; readonly output: number }> = {
  "gpt-5.6-luna": { input: 0.2, output: 1.2 },
  "gpt-4o": { input: 2.5, output: 10 }
}

export interface Usage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly calls: number
  readonly cacheHits: number
}

export const usageCostUsd = (model: string, usage: Usage): number => {
  const price = PRICING[model] ?? { input: 0, output: 0 }
  return (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000
}

const EMPTY: Usage = { inputTokens: 0, outputTokens: 0, calls: 0, cacheHits: 0 }

export interface GenerateOptions<A, I extends Record<string, unknown>> {
  /** Groups cache entries on disk, e.g. `extract`, `supersede`, `anchors`, `read`. */
  readonly kind: string
  readonly system: string
  readonly prompt: string
  readonly schema: Schema.Schema<A, I>
  /** Some providers use this as extra guidance for the structured output. */
  readonly objectName: string
}

export interface Generated<A> {
  readonly value: A
  readonly cached: boolean
}

const make = Effect.gen(function* () {
  const model = yield* Config.string("PALIMPSEST_MODEL").pipe(Config.withDefault("gpt-5.6-luna"))
  const cacheDir = yield* Config.string("PALIMPSEST_LLM_CACHE").pipe(
    Config.withDefault(defaultCacheDir())
  )
  const concurrency = yield* Config.integer("PALIMPSEST_LLM_CONCURRENCY").pipe(Config.withDefault(8))

  const usageRef = yield* Ref.make(EMPTY)
  // One semaphore for the whole process, so callers can fan out freely without
  // any of them having to know the provider's rate limit.
  const gate = yield* Effect.makeSemaphore(concurrency)

  /** Transient provider failures — 429 and 5xx — are worth a few retries. */
  const retrySchedule = Schedule.exponential("1 second", 2).pipe(
    Schedule.jittered,
    Schedule.compose(Schedule.recurs(4))
  )

  const generateObject = <A, I extends Record<string, unknown>>(
    options: GenerateOptions<A, I>
  ): Effect.Effect<Generated<A>, AiError.AiError, LanguageModel.LanguageModel> =>
    Effect.gen(function* () {
      const schemaJson = JSONSchema.make(options.schema)
      const key = cacheKey({
        model,
        system: options.system,
        prompt: options.prompt,
        schema: schemaJson
      })

      const cached = yield* Effect.promise(() => readCache(cacheDir, options.kind, key))
      if (cached !== undefined) {
        const decoded = yield* Schema.decodeUnknown(options.schema)(cached.value).pipe(
          Effect.option
        )
        if (decoded._tag === "Some") {
          yield* Ref.update(usageRef, (u) => ({ ...u, cacheHits: u.cacheHits + 1 }))
          return { value: decoded.value, cached: true }
        }
        // A cache entry that no longer decodes means the schema moved; fall
        // through and re-ask rather than silently serving a stale shape.
      }

      const response = yield* gate.withPermits(1)(
        LanguageModel.generateObject({
          prompt: [
            { role: "system", content: options.system },
            { role: "user", content: [{ type: "text", text: options.prompt }] }
          ],
          schema: options.schema,
          objectName: options.objectName
        }).pipe(Effect.retry(retrySchedule))
      )

      const inputTokens = response.usage.inputTokens ?? 0
      const outputTokens = response.usage.outputTokens ?? 0
      yield* Ref.update(usageRef, (u) => ({
        inputTokens: u.inputTokens + inputTokens,
        outputTokens: u.outputTokens + outputTokens,
        calls: u.calls + 1,
        cacheHits: u.cacheHits
      }))

      const encoded = yield* Schema.encode(options.schema)(response.value).pipe(Effect.orDie)
      yield* Effect.promise(() =>
        writeCache(cacheDir, options.kind, key, {
          model,
          value: encoded,
          inputTokens,
          outputTokens
        })
      )

      return { value: response.value, cached: false }
    })

  const usage = Ref.get(usageRef)
  const resetUsage = Ref.set(usageRef, EMPTY)

  return { model, cacheDir, concurrency, generateObject, usage, resetUsage } as const
})

export class Llm extends Effect.Service<Llm>()("palimpsest/Llm", { effect: make }) {}
