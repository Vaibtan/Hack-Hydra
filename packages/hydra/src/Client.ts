import { HttpClient } from "@effect/platform"
import { Config, Effect, Either, FiberRef, Option } from "effect"
import { isLimit, oversizeProperty } from "./Classify.js"
import { DELETE_ROWS_PER_CHUNK, MERGE_ROWS_PER_CHUNK, writeChunked } from "./Chunking.js"
import {
  DELETE_BY_ID_STATEMENT,
  FULL_KEY_PROPERTY,
  MAX_STRING_PROPERTY_BYTES,
  renderGetByIdQuery,
  renderMsPathsQuery,
  renderRelMergeStatement,
  renderVertexMergeStatement,
  requireIdentifier,
  type MsPathsConfig
} from "./Cypher.js"
import type { HydraPath, QueryResult, Row, Scalar } from "./Decode.js"
import {
  HydraLimitError,
  HydraParseError,
  type HydraError,
  type HydraIdentityIntegrityError
} from "./Errors.js"
import { identityEffect, makeIdentity } from "./Identity.js"
import { edgeId, vertexId } from "./Ids.js"
import { makeTransport, type QueryOptions } from "./Transport.js"

export type { QueryOptions } from "./Transport.js"

/** Scalar statement parameters. Lists of maps are handled by the batch methods. */
export type Params = Record<string, Scalar>

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

const firstFailure = <E>(claims: Iterable<() => Either.Either<unknown, E>>): E | undefined => {
  for (const claim of claims) {
    const outcome = claim()
    if (outcome._tag === "Left") return outcome.left
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
  const bookmarkRef = FiberRef.unsafeMake<Option.Option<string>>(Option.none())
  const identity = makeIdentity()
  const send = makeTransport({ baseUrl, token, graph, cellId, http, bookmarkRef })

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

  const sendChunked = (
    statement: string,
    payload: ReadonlyArray<Readonly<Record<string, unknown>>>,
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
          ...(row.properties ?? {})
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
        .filter((cell): cell is HydraPath => cell !== null && typeof cell === "object")
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
    bookmark: string,
    operation: Effect.Effect<A, E, R>
  ): Effect.Effect<A, E, R> => Effect.locally(operation, bookmarkRef, Option.some(bookmark))

  const lastBookmark = FiberRef.get(bookmarkRef)

  return {
    query,
    getById,
    batchMerge,
    batchRel,
    msPaths,
    deleteByKeys,
    withCausalBookmark,
    lastBookmark
  } as const
})

export class HydraClient extends Effect.Service<HydraClient>()("palimpsest/HydraClient", {
  effect: make
}) {}
