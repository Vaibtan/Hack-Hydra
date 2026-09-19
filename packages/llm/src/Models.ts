import { Effect, Schema } from "effect"

const ModelsResponse = Schema.Struct({
  data: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Schema.optionalKey(Schema.String) })))
})

/** The model every read-path call defaults to; the reader is frozen at it for the v1-vs-v2 comparison. */
export const DEFAULT_MODEL = "gpt-5.6-luna"

export interface ReadPathModels {
  readonly reader: string
  readonly select: string
  readonly sufficiency: string
}

/** An environment variable's model id, with unset and `""` both meaning "not configured". */
export const configuredModel = (variable: string): string | undefined => {
  const value = process.env[variable]
  return value === undefined || value === "" ? undefined : value
}

export const resolveReadPathModels = (fallback: string = DEFAULT_MODEL): ReadPathModels => {
  const reader = configuredModel("PALIMPSEST_MODEL") ?? fallback
  return {
    reader,
    select: configuredModel("PALIMPSEST_SELECT_MODEL") ?? reader,
    sufficiency: configuredModel("PALIMPSEST_SUFFICIENCY_MODEL") ?? reader
  }
}

export const readPathModels = (fallback: string): ReadPathModels => resolveReadPathModels(fallback)

export const distinctIds = (models: ReadPathModels, extra: ReadonlyArray<string> = []): ReadonlyArray<string> =>
  [...new Set([models.reader, models.select, models.sufficiency, ...extra])].sort()

export class UnknownModelError extends Error {
  constructor(
    readonly unknown: ReadonlyArray<string>,
    readonly available: ReadonlyArray<string>
  ) {
    super(
      `unknown model id${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}\n` +
        `  the provider lists ${available.length} models; the closest are: ` +
        `${available.slice(0, 12).join(", ")}\n` +
        `  set PALIMPSEST_MODEL / PALIMPSEST_SELECT_MODEL / PALIMPSEST_SUFFICIENCY_MODEL to ids it knows`
    )
    this.name = "UnknownModelError"
  }
}

export const unknownIds = (
  ids: ReadonlyArray<string>,
  available: ReadonlyArray<string>
): ReadonlyArray<string> => {
  const known = new Set(available)
  return ids.filter((id) => !known.has(id))
}

export const listModels = (
  baseUrl: string,
  apiKey: string,
  fetchModels: typeof fetch = fetch
): Effect.Effect<ReadonlyArray<string> | null> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetchModels(`${baseUrl.replace(/\/$/, "")}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` }
      })
      if (!response.ok) return null
      const body = Schema.decodeUnknownSync(ModelsResponse)(await response.json())
      const ids = (body.data ?? [])
        .map((row) => String(row.id ?? ""))
        .filter((id) => id !== "")
      return ids.length === 0 ? null : ids
    },
    catch: () => new Error("unreachable")
  }).pipe(Effect.catch(() => Effect.succeed(null)))

/** Fails closed on an id the provider does not list, and only on that; an unreachable provider warns and returns `null`. */
export const verifyModels = (
  models: ReadPathModels,
  options: {
    readonly baseUrl?: string
    readonly apiKey?: string
    readonly extra?: ReadonlyArray<string>
    readonly fetch?: typeof fetch
  } = {}
): Effect.Effect<ReadonlyArray<string> | null, UnknownModelError> =>
  Effect.gen(function* () {
    const baseUrl = options.baseUrl ?? process.env["OPENAI_BASE_URL"] ?? "https://api.openai.com/v1"
    const apiKey = options.apiKey ?? process.env["OPENAI_API_KEY"] ?? ""
    const ids = distinctIds(models, options.extra ?? [])
    if (apiKey === "") return null

    const available = yield* listModels(baseUrl, apiKey, options.fetch)
    if (available === null) {
      console.error(
        `warning: could not list models at ${baseUrl}; not verifying ${ids.join(", ")}`
      )
      return null
    }
    const unknown = unknownIds(ids, available)
    if (unknown.length > 0) return yield* Effect.fail(new UnknownModelError(unknown, available))
    return available
  })

export interface StartupVerifyOptions {
  readonly fallback?: string
  /** Ids outside the read path the process also uses, such as the eval's judge. */
  readonly extra?: ReadonlyArray<string>
  readonly quiet?: boolean
  readonly fetch?: typeof fetch
  readonly exit?: (code: number) => void
}

export const verifyModelsAtStartup = (
  options: StartupVerifyOptions = {}
): Effect.Effect<void, UnknownModelError> =>
  Effect.gen(function* () {
    const models = resolveReadPathModels(options.fallback ?? DEFAULT_MODEL)
    const verified = yield* verifyModels(models, {
      ...(options.extra !== undefined && { extra: options.extra }),
      ...(options.fetch !== undefined && { fetch: options.fetch })
    })
    if (options.quiet !== true && verified !== null) {
      console.error(
        `models       reader ${models.reader}, select ${models.select}, ` +
          `sufficiency ${models.sufficiency} — verified against the provider`
      )
    }
  })

export const verifyModelsOrExit = (options: StartupVerifyOptions = {}): Effect.Effect<void> =>
  verifyModelsAtStartup(options).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        console.error(error.message)
        const exit = options.exit ?? process.exit
        exit(2)
      })
    )
  )
