import { Effect } from "effect"

/**
 * The model ids the read path uses, verified against the provider before a run
 * starts.
 *
 * Three ids and not one, because the three calls are different jobs: the reader
 * answers from verbatim text, the selector reads a table of index entries, and
 * the sufficiency check judges a pack. They default to the same model so that
 * setting nothing is the frozen comparison, and each is separately overridable
 * so a later experiment can move one without moving the others.
 *
 * **The reader is frozen at `gpt-5.6-luna` for the whole v1-vs-v2 comparison.**
 * That is a decision, not a default: v1's numbers were measured with it, and a
 * reader change would make every paired result a comparison of two things.
 *
 * Verification fails closed. A typo in a model id is otherwise a five-hour run
 * that produces a table of provider errors, or — worse on a provider that
 * silently substitutes — a table of real numbers from a model nobody chose.
 */

export interface ReadPathModels {
  readonly reader: string
  readonly select: string
  readonly sufficiency: string
}

export const readPathModels = (fallback: string): ReadPathModels => ({
  reader: process.env["PALIMPSEST_MODEL"] ?? fallback,
  select: process.env["PALIMPSEST_SELECT_MODEL"] ?? process.env["PALIMPSEST_MODEL"] ?? fallback,
  sufficiency:
    process.env["PALIMPSEST_SUFFICIENCY_MODEL"] ?? process.env["PALIMPSEST_MODEL"] ?? fallback
})

/** The distinct ids to verify — usually one, at most three. */
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

/**
 * Which of `ids` the provider does not list.
 *
 * Pure, so the failure message is testable without a network call — the message
 * is the whole point of this check, and a check whose message is untested is a
 * check that will be unreadable the one time it fires.
 */
export const unknownIds = (
  ids: ReadonlyArray<string>,
  available: ReadonlyArray<string>
): ReadonlyArray<string> => {
  const known = new Set(available)
  return ids.filter((id) => !known.has(id))
}

/** The provider's model list, or `null` when it cannot be reached. */
export const listModels = (
  baseUrl: string,
  apiKey: string
): Effect.Effect<ReadonlyArray<string> | null> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` }
      })
      if (!response.ok) return null
      const body = (await response.json()) as { readonly data?: ReadonlyArray<{ id?: unknown }> }
      const ids = (body.data ?? [])
        .map((row) => String(row.id ?? ""))
        .filter((id) => id !== "")
      return ids.length === 0 ? null : ids
    },
    catch: () => new Error("unreachable")
  }).pipe(Effect.catchAll(() => Effect.succeed(null)))

/**
 * Verifies the read-path ids, failing closed on an id the provider does not
 * list — and *only* on that.
 *
 * A provider that cannot be reached, or whose `/models` endpoint is missing or
 * empty, is not evidence that an id is wrong. It returns null, this warns and
 * proceeds, and the run fails on the first real call if the id was in fact
 * wrong. Refusing to start because a listing endpoint was down would make an
 * unrelated outage look like a configuration error.
 */
export const verifyModels = (
  models: ReadPathModels,
  options: {
    readonly baseUrl?: string
    readonly apiKey?: string
    readonly extra?: ReadonlyArray<string>
  } = {}
): Effect.Effect<ReadonlyArray<string> | null, UnknownModelError> =>
  Effect.gen(function* () {
    const baseUrl = options.baseUrl ?? process.env["OPENAI_BASE_URL"] ?? "https://api.openai.com/v1"
    const apiKey = options.apiKey ?? process.env["OPENAI_API_KEY"] ?? ""
    const ids = distinctIds(models, options.extra ?? [])
    if (apiKey === "") return null

    const available = yield* listModels(baseUrl, apiKey)
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

/** The reader model the whole v1-vs-v2 comparison is frozen at. */
export const DEFAULT_MODEL = "gpt-5.6-luna"

/**
 * The startup check, for a process that is about to spend money.
 *
 * The eval has verified its ids since #31; the server, the demo behind it and
 * every CLI did not, which left the check protecting the one caller least
 * likely to be run with a hand-edited `PALIMPSEST_SELECT_MODEL`. A demo in front
 * of an audience is the caller that can least afford to discover a bad id on
 * its first question.
 *
 * It **fails closed on an unknown id and only on that**. A provider that cannot
 * be reached, or whose `/models` endpoint is missing or empty, warns and
 * proceeds: an unrelated outage must not look like a configuration error. On an
 * unknown id it prints `UnknownModelError`'s message — which names every unknown
 * id, what the provider does list, and the three environment variables that fix
 * it — and exits 2, because a process that starts anyway spends real money
 * producing a table of provider errors.
 *
 * `extra` is for ids outside the read path that the process also uses, such as
 * the eval's judge.
 */
export const verifyModelsAtStartup = (
  options: {
    readonly fallback?: string
    readonly extra?: ReadonlyArray<string>
    readonly quiet?: boolean
  } = {}
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const models = readPathModels(options.fallback ?? process.env["PALIMPSEST_MODEL"] ?? DEFAULT_MODEL)
    const verified = yield* verifyModels(models, {
      ...(options.extra === undefined ? {} : { extra: options.extra })
    }).pipe(
      Effect.catchAll((error: UnknownModelError) =>
        Effect.sync(() => {
          console.error(error.message)
          process.exit(2)
        })
      )
    )
    if (options.quiet !== true && verified !== null && verified !== undefined) {
      console.error(
        `models       reader ${models.reader}, select ${models.select}, ` +
          `sufficiency ${models.sufficiency} — verified against the provider`
      )
    }
  })
