import { Config, Context, Effect, Layer, Ref, Schedule, Schema, Semaphore } from "effect"
import { LanguageModel, type AiError } from "effect/unstable/ai"
import { cacheKey, defaultCacheDir, readCache, writeCache } from "./Cache.js"
import { DEFAULT_MODEL, configuredModel } from "./Models.js"
import { languageModelLayer } from "./Provider.js"

export interface ModelPricing {
  readonly input: number
  readonly output: number
}

export interface PricingCatalog {
  readonly [model: string]: ModelPricing
}

export const PRICING: PricingCatalog = {
  [DEFAULT_MODEL]: { input: 0.2, output: 1.2 },
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
  readonly schema: Schema.Codec<A, I>
  /** Some providers use this as extra guidance for the structured output. */
  readonly objectName: string
  /** A different model for this one call, with its own transport and cache entries. */
  readonly model?: string
}

export interface Generated<A> {
  readonly value: A
  readonly cached: boolean
  readonly model: string
  /** This one call's cost, replayed from the cache entry on a hit. */
  readonly inputTokens: number
  readonly outputTokens: number
}

export interface GenerateTextOptions {
  readonly kind: string
  readonly system?: string
  readonly prompt: string
  readonly model?: string
}

/** 429, 5xx and transport failures; a 400 or a malformed input/output is the same answer on every attempt. */
export const isTransient = (error: AiError.AiError): boolean => {
  return error.isRetryable
}

const make = Effect.gen(function* () {
  const model = configuredModel("PALIMPSEST_MODEL") ?? DEFAULT_MODEL
  const defaultLanguageModel = yield* LanguageModel.LanguageModel
  const cacheDir = yield* Config.string("PALIMPSEST_LLM_CACHE").pipe(
    Config.withDefault(defaultCacheDir())
  )
  const concurrency = yield* Config.int("PALIMPSEST_LLM_CONCURRENCY").pipe(Config.withDefault(8))

  const usageRef = yield* Ref.make(new Map<string, Usage>())
  const gate = yield* Semaphore.make(concurrency)

  const retrySchedule = Schedule.exponential("1 second", 2).pipe(
    Schedule.jittered,
    Schedule.upTo({ times: 4 })
  )

  const scope = yield* Effect.scope
  const memoMap = yield* Layer.makeMemoMap
  const layers = new Map<string, Layer.Layer<LanguageModel.LanguageModel>>()
  const layerFor = (name: string): Layer.Layer<LanguageModel.LanguageModel> => {
    const found = layers.get(name)
    if (found !== undefined) return found
    const created = languageModelLayer(name).pipe(Layer.orDie)
    layers.set(name, created)
    return created
  }

  const languageModelFor = (
    name: string
  ): Effect.Effect<LanguageModel.LanguageModel["Service"]> => {
    if (name === model) return Effect.succeed(defaultLanguageModel)
    return Layer.buildWithMemoMap(layerFor(name), memoMap, scope).pipe(
      Effect.map((context) => Context.get(context, LanguageModel.LanguageModel))
    )
  }

  const record = (name: string, inputTokens: number, outputTokens: number, hit: boolean) =>
    Ref.update(usageRef, (all) => {
      const current = all.get(name) ?? EMPTY
      const next = new Map(all)
      next.set(name, {
        inputTokens: current.inputTokens + inputTokens,
        outputTokens: current.outputTokens + outputTokens,
        calls: current.calls + (hit ? 0 : 1),
        cacheHits: current.cacheHits + (hit ? 1 : 0)
      })
      return next
    })

  const withModel = <A, E>(
    name: string,
    call: Effect.Effect<A, E, LanguageModel.LanguageModel>
  ): Effect.Effect<A, E> =>
    Effect.gen(function* () {
      const gated = gate.withPermits(1)(call)
      const selectedModel = yield* languageModelFor(name)
      return yield* gated.pipe(
        Effect.provideService(LanguageModel.LanguageModel, selectedModel)
      )
    })

  const generateObject = <A, I extends Record<string, unknown>>(
    options: GenerateOptions<A, I>
  ): Effect.Effect<Generated<A>, AiError.AiError> =>
    Effect.gen(function* () {
      const using = options.model ?? model
      const schemaJson = Schema.toJsonSchemaDocument(options.schema)
      const key = cacheKey({
        model: using,
        system: options.system,
        prompt: options.prompt,
        schema: schemaJson
      })

      const cached = yield* Effect.promise(() => readCache(cacheDir, options.kind, key))
      if (cached !== undefined) {
        const decoded = yield* Schema.decodeUnknownEffect(options.schema)(cached.value).pipe(Effect.option)
        if (decoded._tag === "Some") {
          yield* record(using, 0, 0, true)
          return {
            value: decoded.value,
            cached: true,
            model: using,
            inputTokens: cached.inputTokens,
            outputTokens: cached.outputTokens
          }
        }
      }

      const response = yield* withModel(
        using,
        LanguageModel.generateObject({
          prompt: [
            { role: "system", content: options.system },
            { role: "user", content: [{ type: "text", text: options.prompt }] }
          ],
          schema: options.schema,
          objectName: options.objectName
        }).pipe(Effect.retry({ schedule: retrySchedule, while: isTransient }))
      )

      const inputTokens = response.usage.inputTokens.total ?? 0
      const outputTokens = response.usage.outputTokens.total ?? 0
      yield* record(using, inputTokens, outputTokens, false)

      const encoded = yield* Schema.encodeEffect(options.schema)(response.value).pipe(Effect.orDie)
      yield* Effect.promise(() =>
        writeCache(cacheDir, options.kind, key, {
          model: using,
          value: encoded,
          inputTokens,
          outputTokens,
          system: options.system ?? "",
          prompt: options.prompt
        })
      )

      return { value: response.value, cached: false, model: using, inputTokens, outputTokens }
    })

  const generateText = (
    options: GenerateTextOptions
  ): Effect.Effect<Generated<string>, AiError.AiError> =>
    Effect.gen(function* () {
      const using = options.model ?? model
      const key = cacheKey({
        model: using,
        system: options.system ?? "",
        prompt: options.prompt,
        schema: { form: "text" }
      })

      const cached = yield* Effect.promise(() => readCache(cacheDir, options.kind, key))
      if (cached !== undefined && Schema.is(Schema.String)(cached.value)) {
        yield* record(using, 0, 0, true)
        return {
          value: cached.value,
          cached: true,
          model: using,
          inputTokens: cached.inputTokens,
          outputTokens: cached.outputTokens
        }
      }

      const system = options.system
      const response = yield* withModel(
        using,
        LanguageModel.generateText({
          prompt:
            system === undefined
              ? [{ role: "user" as const, content: [{ type: "text" as const, text: options.prompt }] }]
              : [
                { role: "system" as const, content: system },
                { role: "user" as const, content: [{ type: "text" as const, text: options.prompt }] }
              ]
        }).pipe(Effect.retry({ schedule: retrySchedule, while: isTransient }))
      )

      const inputTokens = response.usage.inputTokens.total ?? 0
      const outputTokens = response.usage.outputTokens.total ?? 0
      yield* record(using, inputTokens, outputTokens, false)
      yield* Effect.promise(() =>
        writeCache(cacheDir, options.kind, key, {
          model: using,
          value: response.text,
          inputTokens,
          outputTokens,
          system: options.system ?? "",
          prompt: options.prompt
        })
      )

      return { value: response.text, cached: false, model: using, inputTokens, outputTokens }
    })

  const usageByModel = Ref.get(usageRef).pipe(
    Effect.map((all): ReadonlyMap<string, Usage> => new Map(all))
  )

  const usage = Ref.get(usageRef).pipe(
    Effect.map((all) =>
      [...all.values()].reduce(
        (total, one) => ({
          inputTokens: total.inputTokens + one.inputTokens,
          outputTokens: total.outputTokens + one.outputTokens,
          calls: total.calls + one.calls,
          cacheHits: total.cacheHits + one.cacheHits
        }),
        EMPTY
      )
    )
  )

  const costUsd = Ref.get(usageRef).pipe(
    Effect.map((all) => [...all].reduce((total, [name, one]) => total + usageCostUsd(name, one), 0))
  )

  const resetUsage = Ref.set(usageRef, new Map<string, Usage>())

  return {
    model,
    cacheDir,
    concurrency,
    generateObject,
    generateText,
    usage,
    usageByModel,
    costUsd,
    resetUsage
  } as const
})

export type Llm = Effect.Success<typeof make>
const LlmTag = Context.Service<Llm>("palimpsest/Llm")
export const Llm = Object.assign(LlmTag, { layer: Layer.effect(LlmTag, make) })
