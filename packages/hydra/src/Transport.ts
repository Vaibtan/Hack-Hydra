import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Context, Duration, Effect, Option, Result, Schedule, Schema } from "effect"
import { randomUUID } from "node:crypto"
import { classifyHydraHttpError, HydraErrorBodySchema, isRetryable } from "./Classify.js"
import { MAX_BODY_BYTES } from "./Cypher.js"
import { decodePage, RawResponseSchema, type QueryPage, type QueryResult } from "./Decode.js"
import { HydraLimitError, HydraUnavailable, type HydraError } from "./Errors.js"
import type { JsonObject, JsonValue } from "./JsonValue.js"
import { followCursor, type Page } from "./Paging.js"

export interface QueryOptions {
  /** Read at or after this causal floor. Defaults to the last write's bookmark. */
  readonly bookmark?: string
  /** Skip bookmark threading entirely (used by health checks). */
  readonly fresh?: boolean
}

export interface TransportConfig {
  readonly baseUrl: string
  readonly token: string
  readonly graph: string
  readonly cellId: string
  readonly http: HttpClient.HttpClient
}

interface HydraRequestBody {
  [key: string]: JsonValue
}

/**
 * Fiber-local causal bookmark state. The cached default is immutable; updates
 * replace the current fiber's reference value instead of mutating shared state.
 */
export const CurrentHydraBookmark = Context.Reference<Option.Option<string>>(
  "palimpsest/CurrentHydraBookmark",
  { defaultValue: Option.none }
)

const setCurrentHydraBookmark = (bookmark: string): Effect.Effect<void> =>
  Effect.scoped(
    Effect.updateServiceScoped(
      CurrentHydraBookmark,
      () => Option.some(bookmark),
      { reset: (_original, updated) => updated }
    )
  )

export type Send = (
  query: string,
  parameters: JsonObject,
  options?: QueryOptions
) => Effect.Effect<QueryResult, HydraError>

/** Seven attempts over ~6 s of jittered backoff, inside the engine's 30 s runtime cap. */
const RETRYABLE_SCHEDULE = Schedule.max([
  Schedule.exponential(Duration.millis(100), 2).pipe(Schedule.jittered),
  Schedule.recurs(6)
])

const asPage = (result: QueryPage): Page => ({
  rows: result.rows,
  nextCursor: result.nextCursor,
  queryId: result.queryId
})

export const createTransport = (config: TransportConfig): Send => {
  const { baseUrl, token, graph, cellId, http } = config
  const endpoint = `${baseUrl.replace(/\/$/, "")}/v1/graphs/${graph}/query`

  const post = (body: JsonObject, query: string): Effect.Effect<QueryPage, HydraError> =>
    Effect.gen(function* () {
      const payload = JSON.stringify(body)
      if (Buffer.byteLength(payload, "utf8") > MAX_BODY_BYTES) {
        return yield* new HydraLimitError({
          reason: `request body is ${Buffer.byteLength(payload, "utf8")} bytes, over the 1 MB cap`,
          status: 413,
          query
        })
      }

      const request = HttpClientRequest.post(endpoint).pipe(
        HttpClientRequest.setHeaders({
          Authorization: `Bearer ${token}`,
          "X-Graph-Namespace": graph,
          "Content-Type": "application/json"
        }),
        HttpClientRequest.bodyJsonUnsafe(body)
      )

      const response = yield* http.execute(request).pipe(
        Effect.mapError((cause) => new HydraUnavailable({ reason: String(cause), cause }))
      )
      const json = yield* response.json.pipe(
        Effect.mapError((cause) => new HydraUnavailable({ reason: "unreadable response body", cause }))
      )

      if (response.status >= 400) {
        const parsed = Schema.decodeUnknownResult(HydraErrorBodySchema)(json)
        const errorBody = Result.isSuccess(parsed) ? parsed.success : {}
        return yield* classifyHydraHttpError(response.status, errorBody, query)
      }
      const parsed = yield* Schema.decodeUnknownEffect(RawResponseSchema)(json).pipe(
        Effect.mapError(
          (cause) => new HydraUnavailable({ reason: "response body violates the HydraDB protocol", cause })
        )
      )
      return decodePage(parsed)
    })

  const sendOnce: Send = (query, parameters, options) =>
    Effect.gen(function* () {
      const stored = yield* CurrentHydraBookmark
      const bookmark = options?.fresh === true ? undefined : (options?.bookmark ?? Option.getOrUndefined(stored))
      const requestId = `palimpsest-${randomUUID()}`
      const body: HydraRequestBody = { cell_id: cellId, query, query_id: requestId }
      if (Object.keys(parameters).length > 0) body["parameters"] = parameters
      if (bookmark !== undefined) body["bookmark"] = bookmark

      const first = yield* post(body, query)
      const rows = yield* followCursor(
        asPage(first),
        (cursor, queryId) =>
          post({ ...body, cursor, query_id: queryId }, query).pipe(Effect.map(asPage)),
        query
      )

      return { columns: first.columns, rows, bookmark: first.bookmark, readEpoch: first.readEpoch }
    })

  return (query, parameters, options) =>
    Effect.retry(sendOnce(query, parameters, options), {
      schedule: RETRYABLE_SCHEDULE,
      while: isRetryable
    }).pipe(
      Effect.tap((result) =>
        result.bookmark === null
          ? Effect.void
          : setCurrentHydraBookmark(result.bookmark)
      )
    )
}
