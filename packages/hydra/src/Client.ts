import { HttpClient, HttpClientRequest } from "@effect/platform"
import { Config, Effect, Option, Ref } from "effect"
import { MAX_BODY_BYTES, renderMsPathsQuery, type MsPathsConfig } from "./Cypher.js"
import { decodeResponse, type HydraPath, type QueryResult, type Scalar } from "./Decode.js"
import { HydraLimitError, HydraParseError, HydraUnavailable } from "./Errors.js"
import { vertexId } from "./Ids.js"

/** Scalar statement parameters. Lists of maps are handled by the batch methods. */
export type Params = Record<string, Scalar>

export interface QueryOptions {
  /** Read at or after this causal floor. Defaults to the last write's bookmark. */
  readonly bookmark?: string
  /** Skip bookmark threading entirely (used by health checks). */
  readonly fresh?: boolean
}

/** One vertex upsert. The client derives the id from `key`; callers never hash. */
export interface VertexRow {
  readonly key: string
  readonly properties: Readonly<Record<string, Scalar>>
}

/** One relationship upsert between two already-written vertices. */
export interface RelRow {
  readonly srcLabel: string
  readonly srcKey: string
  readonly dstLabel: string
  readonly dstKey: string
  readonly properties?: Readonly<Record<string, Scalar>>
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

const requireIdentifier = (kind: string, value: string): string => {
  if (!IDENTIFIER.test(value)) throw new Error(`invalid ${kind} identifier: ${JSON.stringify(value)}`)
  return value
}

const signature = (properties: Readonly<Record<string, Scalar>>): ReadonlyArray<string> =>
  Object.keys(properties).sort()

const groupBySignature = <T>(
  rows: ReadonlyArray<T>,
  key: (row: T) => string
): Map<string, Array<T>> => {
  const groups = new Map<string, Array<T>>()
  for (const row of rows) {
    const k = key(row)
    const existing = groups.get(k)
    if (existing) existing.push(row)
    else groups.set(k, [row])
  }
  return groups
}

/**
 * Split rows so that each chunk's serialized parameter payload stays well under
 * HydraDB's 1 MB HTTP body cap. Sized by measurement rather than a row count,
 * because Turn texts differ by three orders of magnitude.
 */
const BODY_BUDGET = Math.floor(MAX_BODY_BYTES * 0.8)

const chunkByBytes = <T>(rows: ReadonlyArray<T>): Array<Array<T>> => {
  const chunks: Array<Array<T>> = []
  let current: Array<T> = []
  let bytes = 0
  for (const row of rows) {
    const size = Buffer.byteLength(JSON.stringify(row), "utf8") + 1
    if (current.length > 0 && bytes + size > BODY_BUDGET) {
      chunks.push(current)
      current = []
      bytes = 0
    }
    current.push(row)
    bytes += size
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

const errorFromBody = (
  status: number,
  body: unknown,
  query: string
): HydraParseError | HydraLimitError | HydraUnavailable => {
  const error = (body as { error?: { code?: string; message?: string } } | null)?.error
  const reason = error?.message ?? `HTTP ${status}`
  const code = error?.code ?? `http_${status}`
  if (status === 400 || status === 422) {
    return /limit|exceed|too large|too many|cap\b/i.test(reason)
      ? new HydraLimitError({ reason, status, query })
      : new HydraParseError({ reason, code, query })
  }
  if (status === 413 || status === 429) return new HydraLimitError({ reason, status, query })
  return new HydraUnavailable({ reason })
}

const make = Effect.gen(function* () {
  const baseUrl = yield* Config.string("HYDRA_URL").pipe(
    Config.withDefault("http://127.0.0.1:8443")
  )
  const token = yield* Config.string("HYDRA_TOKEN").pipe(
    Config.withDefault("local-development-token-32-bytes")
  )
  const graph = yield* Config.string("HYDRA_GRAPH").pipe(Config.withDefault("default"))
  const cellId = yield* Config.string("HYDRA_CELL").pipe(Config.withDefault("cell-0"))

  const http = yield* HttpClient.HttpClient
  const bookmarkRef = yield* Ref.make<Option.Option<string>>(Option.none())
  const endpoint = `${baseUrl.replace(/\/$/, "")}/v1/graphs/${graph}/query`

  /**
   * One statement, one round trip. Parameters are scalars, or — for the batch
   * forms built in this module — the reserved `rows` list of maps that the
   * client transport accepts.
   */
  const send = (
    query: string,
    parameters: Record<string, unknown>,
    options?: QueryOptions
  ): Effect.Effect<QueryResult, HydraParseError | HydraLimitError | HydraUnavailable> =>
    Effect.gen(function* () {
      const stored = yield* Ref.get(bookmarkRef)
      const bookmark = options?.fresh === true ? undefined : (options?.bookmark ?? Option.getOrUndefined(stored))
      const body: Record<string, unknown> = { cell_id: cellId, query }
      if (Object.keys(parameters).length > 0) body["parameters"] = parameters
      if (bookmark !== undefined) body["bookmark"] = bookmark

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
        HttpClientRequest.bodyUnsafeJson(body)
      )

      const response = yield* http.execute(request).pipe(
        Effect.mapError((cause) => new HydraUnavailable({ reason: String(cause), cause }))
      )
      const json = yield* response.json.pipe(
        Effect.mapError((cause) => new HydraUnavailable({ reason: "unreadable response body", cause }))
      )

      if (response.status >= 400) {
        return yield* errorFromBody(response.status, json, query)
      }

      const result = decodeResponse(json as Parameters<typeof decodeResponse>[0])
      if (result.bookmark !== null) {
        yield* Ref.set(bookmarkRef, Option.some(result.bookmark))
      }
      return result
    })

  const query = (
    cypher: string,
    parameters: Params = {},
    options?: QueryOptions
  ): Effect.Effect<QueryResult, HydraParseError | HydraLimitError | HydraUnavailable> =>
    send(cypher, parameters, options)

  const batchMerge = (
    label: string,
    rows: ReadonlyArray<VertexRow>
  ): Effect.Effect<number, HydraParseError | HydraLimitError | HydraUnavailable> =>
    Effect.gen(function* () {
      if (rows.length === 0) return 0
      requireIdentifier("label", label)
      // A vertex upsert must be MERGE-by-id followed by SET, so the statement
      // names the properties and every row in a chunk needs the same set.
      const groups = groupBySignature(rows, (row) => signature(row.properties).join(","))
      let written = 0
      for (const [, group] of groups) {
        const props = signature(group[0]!.properties)
        if (props.length === 0) {
          return yield* new HydraParseError({
            reason: "UNWIND vertex upsert requires MERGE by id followed by SET",
            code: "invalid_request",
            query: `<batchMerge ${label}>`
          })
        }
        const assignments = props
          .map((p) => `n.${requireIdentifier("property", p)} = row.${p}`)
          .join(", ")
        const statement = `UNWIND $rows AS row MERGE (n {id: row.id}) SET n:${label}, ${assignments}`
        const payload = group.map((row) => ({ id: vertexId(row.key), ...row.properties }))
        for (const chunk of chunkByBytes(payload)) {
          yield* send(statement, { rows: chunk }, {})
          written += chunk.length
        }
      }
      return written
    })

  const batchRel = (
    relType: string,
    rows: ReadonlyArray<RelRow>
  ): Effect.Effect<number, HydraParseError | HydraLimitError | HydraUnavailable> =>
    Effect.gen(function* () {
      if (rows.length === 0) return 0
      requireIdentifier("relType", relType)
      const groups = groupBySignature(
        rows,
        (row) => `${row.srcLabel} ${row.dstLabel} ${signature(row.properties ?? {}).join(",")}`
      )
      let written = 0
      for (const [, group] of groups) {
        const first = group[0]!
        const props = signature(first.properties ?? {})
        requireIdentifier("srcLabel", first.srcLabel)
        requireIdentifier("dstLabel", first.dstLabel)
        // `SET r.id` is rejected by the engine ("cannot update relationship id"),
        // and a property-less MERGE with no SET is accepted, so the SET clause is
        // emitted only when there are real properties to write.
        const setClause =
          props.length === 0
            ? ""
            : ` SET ${props.map((p) => `r.${requireIdentifier("property", p)} = row.${p}`).join(", ")}`
        const statement =
          `UNWIND $rows AS row MATCH (s:${first.srcLabel} {id: row.s}), (d:${first.dstLabel} {id: row.d}) ` +
          `MERGE (s)-[r:${relType} {id: row.r}]->(d)${setClause}`
        const payload = group.map((row) => ({
          s: vertexId(row.srcKey),
          d: vertexId(row.dstKey),
          r: vertexId(`${row.srcKey}|${relType}|${row.dstKey}`),
          ...(row.properties ?? {})
        }))
        for (const chunk of chunkByBytes(payload)) {
          yield* send(statement, { rows: chunk }, {})
          written += chunk.length
        }
      }
      return written
    })

  const msPaths = (
    config: MsPathsConfig
  ): Effect.Effect<ReadonlyArray<HydraPath>, HydraParseError | HydraLimitError | HydraUnavailable> =>
    Effect.gen(function* () {
      if (config.sourceValues.length === 0) return []
      const rendered = renderMsPathsQuery(config)
      const result = yield* send(rendered.query, rendered.parameters, {})
      return result.rows
        .map((row) => row["path"])
        .filter((cell): cell is HydraPath => cell !== null && typeof cell === "object")
    })

  /** Removes vertices and their edges. Used by tests and by re-ingest resets. */
  const deleteByKeys = (
    keys: ReadonlyArray<string>
  ): Effect.Effect<void, HydraParseError | HydraLimitError | HydraUnavailable> =>
    Effect.gen(function* () {
      if (keys.length === 0) return
      const payload = keys.map((key) => ({ id: vertexId(key) }))
      for (const chunk of chunkByBytes(payload)) {
        yield* send("UNWIND $rows AS row MATCH (n {id: row.id}) DETACH DELETE n", { rows: chunk }, {})
      }
    })

  const lastBookmark = Ref.get(bookmarkRef)

  return { query, batchMerge, batchRel, msPaths, deleteByKeys, lastBookmark } as const
})

/**
 * The one seam onto HydraDB. Everything the Cypher subset demands — inlined
 * string lists, MERGE-by-id upserts, body chunking, typed-value decoding,
 * bookmark threading — is hidden behind these six operations.
 */
export class HydraClient extends Effect.Service<HydraClient>()("palimpsest/HydraClient", {
  effect: make
}) {}
