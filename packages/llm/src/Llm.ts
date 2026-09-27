import { Config, Context, Effect, Layer, Redacted, Ref, Result, Schedule, Schema, Semaphore } from "effect"
import { LanguageModel, type AiError } from "effect/unstable/ai"
import { createHash } from "node:crypto"
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
  /** Requested provider model identifier. Kept as `model` for result-envelope compatibility. */
  readonly model: string
  /** Provider-returned model identifier; `null` for historical cache entries that did not retain it. */
  readonly resolvedModel: string | null
  /** Content-addressed cache key for the complete provider request contract. */
  readonly cacheKey: string
  /** This one call's cost, replayed from the cache entry on a hit. */
  readonly inputTokens: number
  readonly outputTokens: number
}

export interface GenerateTextOptions {
  readonly kind: string
  readonly system?: string
  readonly prompt: string
  readonly model?: string
  /** Provider endpoint contract. The LongMemEval judge requires Chat Completions exactly. */
  readonly protocol?: "responses" | "chat-completions"
  readonly temperature?: number
  readonly maxOutputTokens?: number
  readonly n?: 1
}

/** Whether a process may call the provider when an LLM cache entry is absent. */
export type LlmCacheMode = "read-write" | "cache-only"

/** Immutable trace of one LLM decision, sufficient to audit cache and model identity. */
export interface LlmCallTrace {
  readonly kind: string
  readonly cacheKey: string
  readonly cache: "hit" | "live"
  readonly requestedModel: string
  readonly resolvedModel: string | null
  readonly protocol: "responses" | "chat-completions"
  readonly promptSha256: string
  readonly schemaSha256: string
  readonly outputSha256: string
}

/** A cache-only run reached a request that was not present and decodable in the preserved cache. */
export class LlmCacheOnlyMiss extends Error {
  readonly _tag = "LlmCacheOnlyMiss" as const

  constructor(
    readonly kind: string,
    readonly model: string,
    readonly cacheKey: string
  ) {
    super(`cache-only LLM miss for ${kind} using ${model} (${cacheKey})`)
    this.name = "LlmCacheOnlyMiss"
  }
}

/** The exact Chat Completions judge request failed or returned an unusable response. */
export class LlmChatCompletionError extends Error {
  readonly _tag = "LlmChatCompletionError" as const

  constructor(
    readonly status: number | null,
    readonly retryable: boolean,
    override readonly cause: unknown
  ) {
    super(status === null ? "Chat Completions request failed" : `Chat Completions request failed with HTTP ${status}`)
    this.name = "LlmChatCompletionError"
  }
}

const ChatCompletionResponse = Schema.Struct({
  model: Schema.String,
  choices: Schema.Array(
    Schema.Struct({ message: Schema.Struct({ content: Schema.NullOr(Schema.String) }) })
  ),
  usage: Schema.optionalKey(
    Schema.Struct({
      prompt_tokens: Schema.optionalKey(Schema.Number),
      completion_tokens: Schema.optionalKey(Schema.Number)
    })
  )
})

const ResponseMetadataPart = Schema.Struct({
  type: Schema.Literal("response-metadata"),
  modelId: Schema.String
})

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex")

const resolvedModelOf = (content: ReadonlyArray<unknown>): string | null => {
  for (const part of content) {
    const decoded = Schema.decodeUnknownResult(ResponseMetadataPart)(part)
    if (Result.isSuccess(decoded) && decoded.success.modelId !== "") return decoded.success.modelId
  }
  return null
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
  const cacheMode = yield* Config.literals(["read-write", "cache-only"], "PALIMPSEST_LLM_CACHE_MODE").pipe(
    Config.withDefault("read-write")
  )
  const apiBaseUrl = yield* Config.string("OPENAI_BASE_URL").pipe(Config.withDefault("https://api.openai.com/v1"))
  const apiKey = yield* Config.redacted("OPENAI_API_KEY").pipe(Config.withDefault(Redacted.make("")))

  const usageRef = yield* Ref.make(new Map<string, Usage>())
  const traceRef = yield* Ref.make<ReadonlyArray<LlmCallTrace>>([])
  const gate = yield* Semaphore.make(concurrency)

  const retrySchedule = Schedule.exponential("1 second", 2).pipe(
    Schedule.jittered,
    Schedule.upTo({ times: 4 })
  )

  const recordTrace = (trace: LlmCallTrace): Effect.Effect<void> =>
    Ref.update(traceRef, (all) => [...all, trace])

  const traceFor = (input: {
    readonly kind: string
    readonly key: string
    readonly cache: "hit" | "live"
    readonly requestedModel: string
    readonly resolvedModel: string | null
    readonly protocol: "responses" | "chat-completions"
    readonly prompt: string
    readonly schema: unknown
    readonly output: unknown
  }): LlmCallTrace => ({
    kind: input.kind,
    cacheKey: input.key,
    cache: input.cache,
    requestedModel: input.requestedModel,
    resolvedModel: input.resolvedModel,
    protocol: input.protocol,
    promptSha256: sha256(input.prompt),
    schemaSha256: sha256(JSON.stringify(input.schema)),
    outputSha256: sha256(JSON.stringify(input.output))
  })

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
  ): Effect.Effect<Generated<A>, AiError.AiError | LlmCacheOnlyMiss> =>
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
          const resolvedModel = cached.resolvedModel ?? null
          yield* record(using, 0, 0, true)
          yield* recordTrace(
            traceFor({
              kind: options.kind,
              key,
              cache: "hit",
              requestedModel: using,
              resolvedModel,
              protocol: "responses",
              prompt: options.prompt,
              schema: schemaJson,
              output: cached.value
            })
          )
          return {
            value: decoded.value,
            cached: true,
            model: using,
            resolvedModel,
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

      const inputTokens = response.usage.inputTokens.total ?? 0
      const outputTokens = response.usage.outputTokens.total ?? 0
      const resolvedModel = resolvedModelOf(response.content)
      yield* record(using, inputTokens, outputTokens, false)

      const encoded = yield* Schema.encodeEffect(options.schema)(response.value).pipe(Effect.orDie)
      yield* Effect.promise(() =>
        writeCache(cacheDir, options.kind, key, {
          model: using,
          ...(resolvedModel !== null && { resolvedModel }),
          value: encoded,
          inputTokens,
          outputTokens,
          system: options.system ?? "",
          prompt: options.prompt
        })
      )
      yield* recordTrace(
        traceFor({
          kind: options.kind,
          key,
          cache: "live",
          requestedModel: using,
          resolvedModel,
          protocol: "responses",
          prompt: options.prompt,
          schema: schemaJson,
          output: encoded
        })
      )

      return {
        value: response.value,
        cached: false,
        model: using,
        resolvedModel,
        cacheKey: key,
        inputTokens,
        outputTokens
      }
    })

  const chatCompletion = (input: {
    readonly model: string
    readonly prompt: string
    readonly temperature: number
    readonly maxOutputTokens: number
    readonly n: 1
  }): Effect.Effect<typeof ChatCompletionResponse.Type, LlmChatCompletionError> => {
    if (Redacted.value(apiKey) === "") {
      return Effect.fail(new LlmChatCompletionError(null, false, "OPENAI_API_KEY is not configured"))
    }
    const request = {
      model: input.model,
      messages: [{ role: "user", content: input.prompt }],
      temperature: input.temperature,
      max_tokens: input.maxOutputTokens,
      n: input.n
    }
    const call = Effect.tryPromise({
      try: async () => {
        const response = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${Redacted.value(apiKey)}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(request)
        })
        if (!response.ok) {
          throw new LlmChatCompletionError(response.status, response.status === 429 || response.status >= 500, null)
        }
        return Schema.decodeUnknownSync(ChatCompletionResponse)(await response.json())
      },
      catch: (cause) =>
        cause instanceof LlmChatCompletionError
          ? cause
          : new LlmChatCompletionError(null, true, cause)
    }).pipe(Effect.retry({ schedule: retrySchedule, while: (error) => error.retryable }))
    return gate.withPermits(1)(call)
  }

  const generateText = (
    options: GenerateTextOptions
  ): Effect.Effect<Generated<string>, AiError.AiError | LlmCacheOnlyMiss | LlmChatCompletionError> =>
    Effect.gen(function* () {
      const using = options.model ?? model
      const protocol = options.protocol ?? "responses"
      const requestContract =
        protocol === "responses"
          ? { form: "text" as const }
          : {
              form: "text" as const,
              protocol,
              temperature: options.temperature ?? 0,
              maxOutputTokens: options.maxOutputTokens ?? 10,
              n: options.n ?? 1
            }
      const key = cacheKey({
        model: using,
        system: options.system ?? "",
        prompt: options.prompt,
        schema: requestContract
      })

      const cached = yield* Effect.promise(() => readCache(cacheDir, options.kind, key))
      if (cached !== undefined && Schema.is(Schema.String)(cached.value)) {
        const resolvedModel = cached.resolvedModel ?? null
        yield* record(using, 0, 0, true)
        yield* recordTrace(
          traceFor({
            kind: options.kind,
            key,
            cache: "hit",
            requestedModel: using,
            resolvedModel,
            protocol,
            prompt: options.prompt,
            schema: requestContract,
            output: cached.value
          })
        )
        return {
          value: cached.value,
          cached: true,
          model: using,
          resolvedModel,
          cacheKey: key,
          inputTokens: cached.inputTokens,
          outputTokens: cached.outputTokens
        }
      }

      if (cacheMode === "cache-only") return yield* Effect.fail(new LlmCacheOnlyMiss(options.kind, using, key))

      const generated =
        protocol === "chat-completions"
          ? yield* chatCompletion({
              model: using,
              prompt: options.prompt,
              temperature: options.temperature ?? 0,
              maxOutputTokens: options.maxOutputTokens ?? 10,
              n: options.n ?? 1
            }).pipe(
              Effect.flatMap((response) => {
                const value = response.choices[0]?.message.content
                if (value === undefined || value === null) {
                  return Effect.fail(
                    new LlmChatCompletionError(null, false, "the first choice has no text content")
                  )
                }
                return Effect.succeed({
                  value,
                  resolvedModel: response.model,
                  inputTokens: response.usage?.prompt_tokens ?? 0,
                  outputTokens: response.usage?.completion_tokens ?? 0
                })
              })
            )
          : yield* withModel(
              using,
              LanguageModel.generateText({
                prompt:
                  options.system === undefined
                    ? [{ role: "user" as const, content: [{ type: "text" as const, text: options.prompt }] }]
                    : [
                        { role: "system" as const, content: options.system },
                        { role: "user" as const, content: [{ type: "text" as const, text: options.prompt }] }
                      ]
              }).pipe(Effect.retry({ schedule: retrySchedule, while: isTransient }))
            ).pipe(
              Effect.map((response) => ({
                value: response.text,
                resolvedModel: resolvedModelOf(response.content),
                inputTokens: response.usage.inputTokens.total ?? 0,
                outputTokens: response.usage.outputTokens.total ?? 0
              }))
            )

      const { inputTokens, outputTokens, resolvedModel } = generated
      yield* record(using, inputTokens, outputTokens, false)
      yield* Effect.promise(() =>
        writeCache(cacheDir, options.kind, key, {
          model: using,
          ...(resolvedModel !== null && { resolvedModel }),
          value: generated.value,
          inputTokens,
          outputTokens,
          system: options.system ?? "",
          prompt: options.prompt
        })
      )
      yield* recordTrace(
        traceFor({
          kind: options.kind,
          key,
          cache: "live",
          requestedModel: using,
          resolvedModel,
          protocol,
          prompt: options.prompt,
          schema: requestContract,
          output: generated.value
        })
      )

      return {
        value: generated.value,
        cached: false,
        model: using,
        resolvedModel,
        cacheKey: key,
        inputTokens,
        outputTokens
      }
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
  const callTrace = Ref.get(traceRef).pipe(
    Effect.map((all): ReadonlyArray<LlmCallTrace> => [...all])
  )
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

export type Llm = Effect.Success<typeof make>
const LlmTag = Context.Service<Llm>("palimpsest/Llm")
export const Llm = Object.assign(LlmTag, { layer: Layer.effect(LlmTag, make) })
