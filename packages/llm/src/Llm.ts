import { LanguageModel, type AiError } from "@effect/ai"
import { Config, Effect, JSONSchema, Layer, Ref, Schedule, Schema, Scope } from "effect"
import { createHash } from "node:crypto"
import { cacheKey, defaultCacheDir, readCache, writeCache } from "./Cache.js"
import { DEFAULT_MODEL, configuredModel } from "./Models.js"
import { languageModelLayer } from "./Provider.js"

/** Token prices in USD per million tokens. */
export const PRICING: Record<string, { readonly input: number; readonly output: number }> = {
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
  readonly schema: Schema.Schema<A, I>
  /** Some providers use this as extra guidance for the structured output. */
  readonly objectName: string
  /** A different model for this one call, with its own transport and cache entries. */
  readonly model?: string
}

export interface Generated<A> {
  readonly value: A
  readonly cached: boolean
  readonly model: string
  readonly cacheKey: string
  /** This one call's cost, replayed from the cache entry on a hit. */
  readonly inputTokens: number
  readonly outputTokens: number
}

export interface LlmCallTrace {
  readonly kind: string
  readonly cacheKey: string
  readonly cache: "hit" | "live"
  readonly requestedModel: string
  readonly resolvedModel: null
  readonly protocol: "responses"
  readonly promptSha256: string
  readonly schemaSha256: string
  readonly outputSha256: string
}

export class LlmCacheOnlyMiss extends Error {
  readonly _tag = "LlmCacheOnlyMiss" as const
  constructor(readonly kind: string, readonly model: string, readonly cacheKey: string) {
    super(`cache-only LLM miss for ${kind} using ${model} (${cacheKey})`)
    this.name = "LlmCacheOnlyMiss"
  }
}

const sha256 = (value: unknown): string =>
  createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value), "utf8").digest("hex")

export interface GenerateTextOptions {
  readonly kind: string
  readonly system?: string
  readonly prompt: string
  readonly model?: string
}

/** 429, 5xx and transport failures; a 400 or a malformed input/output is the same answer on every attempt. */
export const isTransient = (error: AiError.AiError): boolean => {
  switch (error._tag) {
    case "HttpRequestError":
      return error.reason === "Transport"
    case "HttpResponseError":
      return error.reason !== "StatusCode" || error.response.status === 429 || error.response.status >= 500
    case "MalformedOutput":
    case "UnknownError":
      return true
    default:
      return false
  }
}

const make = Effect.gen(function* () {
  const model = configuredModel("PALIMPSEST_MODEL") ?? DEFAULT_MODEL
  const cacheDir = yield* Config.string("PALIMPSEST_LLM_CACHE").pipe(
    Config.withDefault(defaultCacheDir())
  )
  const concurrency = yield* Config.integer("PALIMPSEST_LLM_CONCURRENCY").pipe(Config.withDefault(8))
  const cacheModeRaw = yield* Config.string("PALIMPSEST_LLM_CACHE_MODE").pipe(Config.withDefault("read-write"))
  const cacheMode =
    cacheModeRaw === "read-write" || cacheModeRaw === "cache-only"
      ? cacheModeRaw
      : yield* Effect.die(new Error(`PALIMPSEST_LLM_CACHE_MODE must be read-write or cache-only, not ${cacheModeRaw}`))

  const usageRef = yield* Ref.make(new Map<string, Usage>())
  const traceRef = yield* Ref.make<ReadonlyArray<LlmCallTrace>>([])
  const gate = yield* Effect.makeSemaphore(concurrency)

  const retrySchedule = Schedule.exponential("1 second", 2).pipe(
    Schedule.jittered,
    Schedule.compose(Schedule.recurs(4))
  )

  const layers = new Map<string, Layer.Layer<LanguageModel.LanguageModel>>()
  const scope = yield* Effect.scope
  const layerFor = (name: string): Effect.Effect<Layer.Layer<LanguageModel.LanguageModel>> =>
    Effect.gen(function* () {
      const found = layers.get(name)
      if (found !== undefined) return found
      const memoized = yield* Layer.memoize(languageModelLayer(name))
      const erased = memoized as unknown as Layer.Layer<LanguageModel.LanguageModel>
      layers.set(name, erased)
      return erased
    }).pipe(Effect.provideService(Scope.Scope, scope), Effect.orDie)

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
  ): Effect.Effect<A, E, LanguageModel.LanguageModel> =>
    Effect.gen(function* () {
      const gated = gate.withPermits(1)(call)
      if (name === model) return yield* gated
      return yield* gated.pipe(Effect.provide(yield* layerFor(name)))
    })

  const generateObject = <A, I extends Record<string, unknown>>(
    options: GenerateOptions<A, I>
  ): Effect.Effect<Generated<A>, AiError.AiError | LlmCacheOnlyMiss, LanguageModel.LanguageModel> =>
    Effect.gen(function* () {
      const using = options.model ?? model
      const schemaJson = JSONSchema.make(options.schema)
      const key = cacheKey({
        model: using,
        system: options.system,
        prompt: options.prompt,
        schema: schemaJson
      })

      const cached = yield* Effect.promise(() => readCache(cacheDir, options.kind, key))
      if (cached !== undefined) {
        const decoded = yield* Schema.decodeUnknown(options.schema)(cached.value).pipe(Effect.option)
        if (decoded._tag === "Some") {
          yield* record(using, 0, 0, true)
          yield* Ref.update(traceRef, (all) => [
            ...all,
            {
              kind: options.kind,
              cacheKey: key,
              cache: "hit" as const,
              requestedModel: using,
              resolvedModel: null,
              protocol: "responses" as const,
              promptSha256: sha256(options.prompt),
              schemaSha256: sha256(schemaJson),
              outputSha256: sha256(cached.value)
            }
          ])
          return {
            value: decoded.value,
            cached: true,
            model: using,
            cacheKey: key,
            inputTokens: cached.inputTokens,
            outputTokens: cached.outputTokens
          }
        }
      }

      if (cacheMode === "cache-only") return yield* Effect.fail(new LlmCacheOnlyMiss(options.kind, using, key))

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

      const inputTokens = response.usage.inputTokens ?? 0
      const outputTokens = response.usage.outputTokens ?? 0
      yield* record(using, inputTokens, outputTokens, false)

      const encoded = yield* Schema.encode(options.schema)(response.value).pipe(Effect.orDie)
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

      yield* Ref.update(traceRef, (all) => [
        ...all,
        {
          kind: options.kind,
          cacheKey: key,
          cache: "live" as const,
          requestedModel: using,
          resolvedModel: null,
          protocol: "responses" as const,
          promptSha256: sha256(options.prompt),
          schemaSha256: sha256(schemaJson),
          outputSha256: sha256(encoded)
        }
      ])

      return { value: response.value, cached: false, model: using, cacheKey: key, inputTokens, outputTokens }
    })

  const generateText = (
    options: GenerateTextOptions
  ): Effect.Effect<Generated<string>, AiError.AiError | LlmCacheOnlyMiss, LanguageModel.LanguageModel> =>
    Effect.gen(function* () {
      const using = options.model ?? model
      const key = cacheKey({
        model: using,
        system: options.system ?? "",
        prompt: options.prompt,
        schema: { form: "text" }
      })
      const textSchema = { form: "text" as const }

      const cached = yield* Effect.promise(() => readCache(cacheDir, options.kind, key))
      if (cached !== undefined && typeof cached.value === "string") {
        yield* record(using, 0, 0, true)
        yield* Ref.update(traceRef, (all) => [
          ...all,
          {
            kind: options.kind,
            cacheKey: key,
            cache: "hit" as const,
            requestedModel: using,
            resolvedModel: null,
            protocol: "responses" as const,
            promptSha256: sha256(options.prompt),
            schemaSha256: sha256(textSchema),
            outputSha256: sha256(cached.value)
          }
        ])
        return {
          value: cached.value,
          cached: true,
          model: using,
          cacheKey: key,
          inputTokens: cached.inputTokens,
          outputTokens: cached.outputTokens
        }
      }

      if (cacheMode === "cache-only") return yield* Effect.fail(new LlmCacheOnlyMiss(options.kind, using, key))

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

      const inputTokens = response.usage.inputTokens ?? 0
      const outputTokens = response.usage.outputTokens ?? 0
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

      yield* Ref.update(traceRef, (all) => [
        ...all,
        {
          kind: options.kind,
          cacheKey: key,
          cache: "live" as const,
          requestedModel: using,
          resolvedModel: null,
          protocol: "responses" as const,
          promptSha256: sha256(options.prompt),
          schemaSha256: sha256(textSchema),
          outputSha256: sha256(response.text)
        }
      ])

      return { value: response.text, cached: false, model: using, cacheKey: key, inputTokens, outputTokens }
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
  const callTrace = Ref.get(traceRef).pipe(Effect.map((all): ReadonlyArray<LlmCallTrace> => [...all]))
  const resetTrace = Ref.set(traceRef, [])

  return {
    model,
    cacheDir,
    concurrency,
    cacheMode,
    generateObject,
    generateText,
    usage,
    usageByModel,
    costUsd,
    resetUsage,
    callTrace,
    resetTrace
  } as const
})

export class Llm extends Effect.Service<Llm>()("palimpsest/Llm", { scoped: make }) {}
