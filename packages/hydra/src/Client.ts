import { HttpClient } from "effect/unstable/http"
import { Config, Context, Effect, Layer, Option, Result, Schema } from "effect"
import { isLimit, oversizeProperty } from "./Classify.js"
import { DELETE_ROWS_PER_CHUNK, MERGE_ROWS_PER_CHUNK, writeChunked } from "./Chunking.js"
import {
  DELETE_BY_ID_STATEMENT,
  FULL_KEY_PROPERTY,
  MAX_STRING_PROPERTY_BYTES,
  renderGetByIdQuery,
  renderGraphIdentityLookupQuery,
  renderMsPathsQuery,
  renderRelMergeStatement,
  renderVertexMergeStatement,
  requireIdentifier,
  type MsPathsConfig
} from "./Cypher.js"
import { isHydraPath, type HydraPath, type QueryResult, type Row, type Scalar } from "./Decode.js"
import {
  HydraLimitError,
  HydraParseError,
  type HydraError,
  type HydraIdentityIntegrityError
} from "./Errors.js"
import { createIdentity, identityEffect } from "./Identity.js"
import { edgeId, vertexId } from "./Ids.js"
import { verifyStoredGraphIdentity } from "./Ids.js"
import type { JsonObject, JsonValue } from "./JsonValue.js"
import { createTransport, CurrentHydraBookmark, type QueryOptions } from "./Transport.js"

export type { QueryOptions } from "./Transport.js"

/** JSON-compatible parameters accepted by HydraDB's query protocol. */
export type Params = Readonly<Record<string, JsonValue>>

/** One vertex upsert. The client derives the id from `key`; callers never hash. */
export interface VertexRow {
  readonly key: string
  readonly properties: Readonly<Record<string, Scalar>>
}

export interface RelRow {
  readonly srcLabel: string
  readonly srcKey: string
  readonly dstLabel: string
  readonly dstKey: string
  readonly properties?: Readonly<Record<string, Scalar>>
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

const reservedProperty = (query: string): HydraParseError =>
  new HydraParseError({
    reason: `${FULL_KEY_PROPERTY} is reserved for Hydra identity verification`,
    code: "invalid_request",
    query
  })

const firstFailure = <E>(claims: Iterable<() => Result.Result<unknown, E>>): E | undefined => {
  for (const claim of claims) {
    const outcome = claim()
    if (outcome._tag === "Failure") return outcome.failure
  }
  return undefined
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
  const identity = createIdentity()
  const send = createTransport({ baseUrl, token, graph, cellId, http })

  const query = (
    cypher: string,
    parameters: Params = {},
    options?: QueryOptions
  ): Effect.Effect<QueryResult, HydraError> =>
    send(cypher, parameters, options)

  const getById = (
    label: string,
    key: string,
    properties: ReadonlyArray<string>
  ): Effect.Effect<Option.Option<Row>, HydraError> =>
    Effect.gen(function* () {
      requireIdentifier("label", label)
      if (properties.length === 0) throw new Error("getById needs at least one property")
      if (properties.includes(FULL_KEY_PROPERTY)) {
        throw new Error(`${FULL_KEY_PROPERTY} is reserved for Hydra identity verification`)
      }
      const id = yield* identityEffect(identity.claimVertexId(key))
      const result = yield* send(renderGetByIdQuery(label, properties), { id }, {})
      const row = result.rows[0]
      if (row === undefined) return Option.none()
      yield* identityEffect(identity.verifyVertexRow(key, id, row))
      return Option.some(row)
    })

  /**
   * Read and verify every graph record already using a reduced id. This is
   * label/type agnostic because Hydra vertex ids are global and relationship
   * ids must be protected across relationship types.
   */
  const readGraphIdentities = (
    kind: "relationship" | "vertex",
    numericId: number
  ): Effect.Effect<ReadonlyArray<string>, HydraError> =>
    Effect.gen(function* () {
      const result = yield* send(renderGraphIdentityLookupQuery(kind), { id: numericId }, {})
      const identities = new Set<string>()
      for (const row of result.rows) {
        const stored = row[FULL_KEY_PROPERTY]
        const canonicalIdentity = Schema.is(Schema.String)(stored) ? stored : null
        yield* identityEffect(
          verifyStoredGraphIdentity({
            kind,
            numericId,
            requestedKey: canonicalIdentity ?? "",
            storedKey: canonicalIdentity
          })
        )
        if (canonicalIdentity !== null) identities.add(canonicalIdentity)
      }
      return [...identities]
    })

  const sendChunked = <T extends JsonObject>(
    statement: string,
    payload: ReadonlyArray<T>,
    maxRows: number
  ): Effect.Effect<number, HydraError> =>
    writeChunked((rows) => send(statement, { rows }, {}), payload, { maxRows })

  const claimVertexRows = (
    rows: ReadonlyArray<VertexRow>,
    query: string
  ): Effect.Effect<void, HydraParseError | HydraIdentityIntegrityError> => {
    for (const row of rows) {
      if (Object.hasOwn(row.properties, FULL_KEY_PROPERTY)) return Effect.fail(reservedProperty(query))
      const failure = firstFailure([() => identity.claimVertexId(row.key)])
      if (failure !== undefined) return Effect.fail(failure)
    }
    return Effect.void
  }

  const batchMerge = (
    label: string,
    rows: ReadonlyArray<VertexRow>
  ): Effect.Effect<number, HydraError> =>
    Effect.gen(function* () {
      if (rows.length === 0) return 0
      requireIdentifier("label", label)
      yield* claimVertexRows(rows, `<batchMerge ${label}>`)
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
        const statement = renderVertexMergeStatement(label, props)
        const payload = group.map((row) => ({
          id: vertexId(row.key),
          [FULL_KEY_PROPERTY]: row.key,
          ...row.properties
        }))
        for (const row of payload) {
          const oversize = oversizeProperty(row)
          if (oversize !== undefined) {
            return yield* new HydraLimitError({
              reason:
                `property '${oversize.property}' is ${oversize.bytes} UTF-8 bytes, over HydraDB's ` +
                `${MAX_STRING_PROPERTY_BYTES}-byte string property cap`,
              status: 413,
              query: `<batchMerge ${label}>`
            })
          }
        }
        written += yield* sendChunked(statement, payload, MERGE_ROWS_PER_CHUNK)
      }
      return written
    })

  const claimRelRows = (
    relType: string,
    rows: ReadonlyArray<RelRow>
  ): Effect.Effect<void, HydraParseError | HydraIdentityIntegrityError> => {
    for (const row of rows) {
      if (Object.hasOwn(row.properties ?? {}, FULL_KEY_PROPERTY)) {
        return Effect.fail(reservedProperty(`<batchRel ${relType}>`))
      }
      const failure = firstFailure([
        () => identity.claimVertexId(row.srcKey),
        () => identity.claimVertexId(row.dstKey),
        () => identity.claimRelationshipId(`${row.srcKey}|${relType}|${row.dstKey}`)
      ])
      if (failure !== undefined) return Effect.fail(failure)
    }
    return Effect.void
  }

  const batchRel = (
    relType: string,
    rows: ReadonlyArray<RelRow>
  ): Effect.Effect<number, HydraError> =>
    Effect.gen(function* () {
      if (rows.length === 0) return 0
      requireIdentifier("relType", relType)
      yield* claimRelRows(relType, rows)
      const groups = groupBySignature(
        rows,
        (row) => `${row.srcLabel} | ${row.dstLabel} | ${signature(row.properties ?? {}).join(",")}`
      )
      let written = 0
      for (const [, group] of groups) {
        const first = group[0]!
        const props = signature(first.properties ?? {})
        const statement = renderRelMergeStatement(relType, first.srcLabel, first.dstLabel, props)
        const payload = group.map((row) => ({
          s: vertexId(row.srcKey),
          d: vertexId(row.dstKey),
          r: edgeId(row.srcKey, relType, row.dstKey),
          [FULL_KEY_PROPERTY]: `${row.srcKey}|${relType}|${row.dstKey}`,
          ...row.properties
        }))
        written += yield* sendChunked(statement, payload, MERGE_ROWS_PER_CHUNK)
      }
      return written
    })

  const msPaths = (
    config: MsPathsConfig
  ): Effect.Effect<ReadonlyArray<HydraPath>, HydraError> =>
    Effect.gen(function* () {
      if (config.sourceValues.length === 0) return []
      const rendered = renderMsPathsQuery(config)
      const result = yield* send(rendered.query, rendered.parameters, {})
      const paths = result.rows
        .map((row) => row["path"])
        .filter(isHydraPath)
      const failure = firstFailure(paths.map((path) => () => identity.verifyPath(path)))
      if (failure !== undefined) return yield* Effect.fail(failure)
      return paths
    })

  /** Halves on a limit error, except the store-wide `delete_vertex_scan_edges` cap, which no batch size fixes. */
  const deleteByKeys = (keys: ReadonlyArray<string>): Effect.Effect<void, HydraError> =>
    writeChunked(
      (rows) => send(DELETE_BY_ID_STATEMENT, { rows }, {}),
      keys.map((key) => ({ id: vertexId(key) })),
      {
        maxRows: DELETE_ROWS_PER_CHUNK,
        halveOn: (error) => isLimit(error) && !/delete_vertex_scan_edges/.test(error.reason)
      }
    ).pipe(Effect.asVoid)

  const withCausalBookmark = <A, E, R>(
    bookmark: string | undefined,
    operation: Effect.Effect<A, E, R>
  ): Effect.Effect<A, E, R> =>
    Effect.suspend(() =>
      Effect.provideService(
        operation,
        CurrentHydraBookmark,
        bookmark === undefined ? Option.none() : Option.some(bookmark)
      )
    )

  const lastBookmark = CurrentHydraBookmark

  return {
    query,
    getById,
    readGraphIdentities,
    batchMerge,
    batchRel,
    msPaths,
    deleteByKeys,
    withCausalBookmark,
    lastBookmark
  } as const
})

export type HydraClient = Effect.Success<typeof make>
const HydraClientTag = Context.Service<HydraClient>("palimpsest/HydraClient")
export const HydraClient = Object.assign(HydraClientTag, { layer: Layer.effect(HydraClientTag, make) })
