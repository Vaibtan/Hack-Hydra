import { HttpClient, HttpClientRequest } from "@effect/platform"
import { Config, Duration, Effect, FiberRef, Option, Schedule, type Either } from "effect"
import { randomUUID } from "node:crypto"
import {
  MAX_BODY_BYTES,
  MAX_STRING_PROPERTY_BYTES,
  renderMsPathsQuery,
  type MsPathsConfig
} from "./Cypher.js"
import { decodeResponse, type HydraPath, type QueryResult, type Row, type Scalar } from "./Decode.js"
import {
  HYDRA_ENGINE_ERROR_CODES,
  HydraEngineError,
  HydraIdentityIntegrityError,
  HydraLimitError,
  HydraParseError,
  HydraUnavailable,
  type HydraEngineErrorCode,
  type HydraError
} from "./Errors.js"
import {
  createGraphIdentityRegistry,
  edgeId,
  verifyStoredGraphIdentity,
  vertexId
} from "./Ids.js"

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
const FULL_KEY_PROPERTY = "__palimpsest_full_key"

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

const identityEffect = <A>(
  outcome: Either.Either<A, HydraIdentityIntegrityError>
): Effect.Effect<A, HydraIdentityIntegrityError> =>
  outcome._tag === "Left" ? Effect.fail(outcome.left) : Effect.succeed(outcome.right)

/**
 * The client's own id for a record, read back off the wire.
 *
 * `NaN` when the property is missing or not a number, which the identity check
 * then reports as a mismatch — the right outcome, because a record this client
 * wrote always carries it.
 */
export const contentAddressedId = (properties: Readonly<Record<string, unknown>>): number =>
  typeof properties["id"] === "number" ? properties["id"] : Number.NaN

/**
 * The backoff for the engine failures that declare themselves retryable
 * (`write_conflict`, `writer_unavailable`, `writer_lease_unavailable`,
 * `object_store_unavailable`).
 *
 * These are *capacity* answers, not wrong statements: the writer lease is being
 * renewed, or MinIO dropped a pooled connection under a burst. A three-user
 * ingest against the benchmark Compose profile hit them within the first
 * minute and lost four whole users, each of which was tens of correct writes
 * away from finishing — so classifying them as retryable and then not retrying
 * was the difference between a failed step load and a clean one.
 *
 * Replay is safe because every write this client issues is a content-addressed
 * `MERGE`, and each attempt carries a fresh `query_id` — the engine's
 * idempotency store keys on that id, so a retry is a new request rather than a
 * conflict with the attempt that failed. Seven attempts over ~6 s of jittered
 * exponential backoff sits well inside the engine's 30 s runtime cap.
 */
const RETRYABLE_SCHEDULE = Schedule.exponential(Duration.millis(100), 2).pipe(
  Schedule.jittered,
  Schedule.intersect(Schedule.recurs(6))
)

/**
 * Split rows so each chunk stays inside *both* of HydraDB's ceilings: the 1 MB
 * HTTP body cap and the 30 s query runtime cap. Bytes alone is not enough,
 * because the two batch forms have wildly different per-row costs (see the
 * constants below), so each declares its own row ceiling.
 */
const BODY_BUDGET = Math.floor(MAX_BODY_BYTES * 0.8)

const chunkRows = <T>(rows: ReadonlyArray<T>, maxRows: number): Array<Array<T>> => {
  const chunks: Array<Array<T>> = []
  let current: Array<T> = []
  let bytes = 0
  for (const row of rows) {
    const size = Buffer.byteLength(JSON.stringify(row), "utf8") + 1
    if (current.length > 0 && (bytes + size > BODY_BUDGET || current.length >= maxRows)) {
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

/**
 * Admission control rejects an `UNWIND` batch of more than 1 024 rows outright:
 * `client_query_batch_items rejected by admission control: actual 2000 exceeds
 * limit 1024`. Writes themselves are fast at this size — 500 vertex upserts in
 * ~55 ms and 1 000 edge upserts in ~40 ms, even on a graph holding a million
 * edges — so the admission cap, not throughput, is what sets this number.
 */
const MERGE_ROWS_PER_CHUNK = 1_000

/**
 * Deletes are a different animal: `DETACH DELETE` retires roughly **2.3
 * vertices per second**, flat in vertex degree (5 -> 2.3 s, 20 -> 10 s,
 * 50 -> 21.6 s) and slower still for large vertices, so the 30 s runtime cap
 * allows about 65 per statement. Deleting a whole benchmark user is an
 * hours-long operation and is not something to build on — every write here is
 * content-addressed and idempotent precisely so re-ingest never needs a reset.
 *
 * Past about a million edges in the store it stops being merely slow and is
 * refused outright: `delete_vertex_scan_edges rejected by admission control:
 * actual 1000001 exceeds limit 1000000`. The scan is proportional to the whole
 * graph, so no batch size makes it work.
 */
const DELETE_ROWS_PER_CHUNK = 40

/**
 * Reads are paged at 1024 rows. This bounds how many pages one statement may
 * pull before we assume something is wrong — 200 pages is 204 800 rows, far
 * past the engine's own 100 k result-vertex cap.
 *
 * Hitting it is an **error**, not a stopping point. Returning the rows gathered
 * so far would be the 1024-row wall all over again, one order of magnitude up:
 * a truncated result that looks exactly like a complete one.
 */
export const MAX_RESULT_PAGES = 200

/** One response's worth of a paged read. */
export interface Page {
  readonly rows: ReadonlyArray<Row>
  readonly nextCursor: string | number | null
  readonly queryId: string | null
}

/**
 * Follows a read's cursor to exhaustion.
 *
 * Split out from `send` so the page cap has a test that does not need a live
 * node — the failure it guards against is one nobody would notice in
 * production, because the wrong answer is well-formed.
 */
export const followCursor = <E>(
  first: Page,
  nextPage: (cursor: string | number, queryId: string | null) => Effect.Effect<Page, E>,
  query: string
): Effect.Effect<ReadonlyArray<Row>, E | HydraLimitError> =>
  Effect.gen(function* () {
    const rows = [...first.rows]
    let cursor = first.nextCursor
    let queryId = first.queryId

    for (let page = 1; cursor !== null && cursor !== ""; page++) {
      if (page > MAX_RESULT_PAGES) {
        return yield* new HydraLimitError({
          reason:
            `result exceeded ${MAX_RESULT_PAGES} pages (${rows.length} rows) and the cursor is ` +
            `still open — refusing to return a silently truncated result`,
          status: 413,
          query
        })
      }
      const next = yield* nextPage(cursor, queryId)
      // An empty page with no further cursor is how a read ends on a boundary.
      if (next.rows.length === 0) break
      rows.push(...next.rows)
      cursor = next.nextCursor
      queryId = next.queryId ?? queryId
    }

    return rows
  })

/**
 * The engine answers an oversize string property with a 500 and no reason, so
 * the check has to happen here — otherwise the caller sees "internal query
 * execution error" and has nothing to act on.
 */
const oversizeProperty = (
  row: Readonly<Record<string, unknown>>
): { readonly property: string; readonly bytes: number } | undefined => {
  for (const [property, value] of Object.entries(row)) {
    if (typeof value !== "string") continue
    const bytes = Buffer.byteLength(value, "utf8")
    if (bytes > MAX_STRING_PROPERTY_BYTES) return { property, bytes }
  }
  return undefined
}

const engineErrorContract: Readonly<
  Record<HydraEngineErrorCode, { readonly status: number; readonly retryable: boolean; readonly reason: string }>
> = {
  idempotency_conflict: {
    status: 409,
    retryable: false,
    reason: "the request id was already used for different content"
  },
  write_conflict: {
    status: 409,
    retryable: true,
    reason: "the graph write conflicted with a concurrent operation"
  },
  writer_unavailable: {
    status: 503,
    retryable: true,
    reason: "the graph writer is not available for this cell"
  },
  writer_lease_unavailable: {
    status: 503,
    retryable: true,
    reason: "the durable writer lease cannot be acquired yet"
  },
  object_store_unavailable: {
    status: 503,
    retryable: true,
    reason: "durable graph storage is temporarily unavailable"
  }
}

const isHydraEngineErrorCode = (value: string): value is HydraEngineErrorCode =>
  HYDRA_ENGINE_ERROR_CODES.some((known) => known === value)

/**
 * Classify a failed HydraDB HTTP response without trusting unreviewed 5xx text.
 *
 * Stable engine codes are accepted only with their declared status. Everything
 * else remains a generic unavailability, so retry and resume policy never
 * depends on a message parser or exposes backend internals.
 */
export const classifyHydraHttpError = (
  status: number,
  body: unknown,
  query: string
): HydraError => {
  const error = (body as { error?: { code?: string; message?: string } } | null)?.error
  const responseCode = error?.code
  if (typeof responseCode === "string" && isHydraEngineErrorCode(responseCode)) {
    const contract = engineErrorContract[responseCode]
    if (contract.status === status) {
      return new HydraEngineError({ code: responseCode, query, ...contract })
    }
  }

  // A 5xx body is not a caller contract. In particular, do not turn an
  // unreviewed body that happens to contain "timeout" into a retry policy or
  // preserve its text in an error that can reach logs or a receipt.
  if (status >= 500) {
    return new HydraUnavailable({ reason: `HydraDB returned HTTP ${status}`, status })
  }

  const reason = error?.message ?? `HTTP ${status}`
  const code = error?.code ?? `http_${status}`
  // The 30 s runtime cap arrives as a 500, so it has to be recognised by its
  // message rather than its status — callers need to tell "your statement was
  // too big" apart from "the engine is down", because the first can be retried
  // by splitting the batch and the second cannot.
  const isLimit = /timeout|exceeded|too large|too many|limit is/i.test(reason)
  if (isLimit) return new HydraLimitError({ reason, status, query })
  if (status === 400 || status === 422) return new HydraParseError({ reason, code, query })
  if (status === 413 || status === 429) return new HydraLimitError({ reason, status, query })
  return new HydraUnavailable({ reason: `HydraDB returned HTTP ${status}`, status })
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
  // A causal token belongs to the request/fiber that received or supplied it.
  // A process-wide Ref would make one user's write a causal floor for every
  // unrelated request and would lose the guarantee across server replicas.
  const bookmarkRef = FiberRef.unsafeMake<Option.Option<string>>(Option.none())
  const identities = createGraphIdentityRegistry()
  const endpoint = `${baseUrl.replace(/\/$/, "")}/v1/graphs/${graph}/query`

  /**
   * One statement, one round trip. Parameters are scalars, or — for the batch
   * forms built in this module — the reserved `rows` list of maps that the
   * client transport accepts.
   */
  const post = (
    body: Record<string, unknown>,
    query: string
  ): Effect.Effect<
    QueryResult & { readonly queryId: string | null },
    HydraError
  > =>
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
        HttpClientRequest.bodyUnsafeJson(body)
      )

      const response = yield* http.execute(request).pipe(
        Effect.mapError((cause) => new HydraUnavailable({ reason: String(cause), cause }))
      )
      const json = yield* response.json.pipe(
        Effect.mapError((cause) => new HydraUnavailable({ reason: "unreadable response body", cause }))
      )

      if (response.status >= 400) {
        return yield* classifyHydraHttpError(response.status, json, query)
      }

      const raw = json as Parameters<typeof decodeResponse>[0] & {
        query_id?: string
        next_cursor?: string | number | null
      }
      return {
        ...decodeResponse(raw),
        queryId: raw.query_id ?? null,
        nextCursor: raw.next_cursor ?? null
      } as QueryResult & { readonly queryId: string | null }
    })

  /**
   * One statement, all of its rows.
   *
   * HydraDB returns **at most 1024 rows per response** and hands back a
   * `next_cursor` when there are more — including from `algo.MSpaths`, which
   * cannot take `SKIP`/`LIMIT` at all. Ignoring that cursor does not fail, it
   * silently truncates, which is the worst possible failure mode for a
   * retrieval system: recall quietly capped with no error anywhere. So every
   * read follows the cursor to exhaustion. Continuing requires **both** the
   * cursor and the originating `query_id`; the cursor alone returns no rows.
   */
  const send = (
    query: string,
    parameters: Record<string, unknown>,
    options?: QueryOptions
  ): Effect.Effect<QueryResult, HydraError> =>
    Effect.retry(sendOnce(query, parameters, options), {
      schedule: RETRYABLE_SCHEDULE,
      while: (error) => error._tag === "HydraEngineError" && error.retryable
    })

  const sendOnce = (
    query: string,
    parameters: Record<string, unknown>,
    options?: QueryOptions
  ): Effect.Effect<QueryResult, HydraError> =>
    Effect.gen(function* () {
      const stored = yield* FiberRef.get(bookmarkRef)
      const bookmark = options?.fresh === true ? undefined : (options?.bookmark ?? Option.getOrUndefined(stored))
      // Every statement carries its own request id.
      //
      // HydraDB derives the idempotency key of a write from the `query_id`, and
      // if the client does not supply one the server names it `http-query-<n>`
      // from a counter that **restarts at 1 when the node restarts**. The
      // idempotency results outlive the counter, so after a restart the n-th
      // relationship merge collides with a completely unrelated one from a
      // previous run: `idempotency key conflict for relationship-import request
      // key http-query-129.unwind-relationship-merge: this key already stored a
      // result for a different payload`. Every write fails, permanently, and
      // nothing in the graph is wrong — it is purely a name collision.
      //
      // The server honours a client-supplied id and echoes it back, so a UUID
      // per statement makes the collision impossible. Deduplication is not lost
      // by this: every write here is content-addressed and idempotent by MERGE,
      // so replaying one is a no-op regardless of its request key.
      const requestId = `palimpsest-${randomUUID()}`
      const body: Record<string, unknown> = { cell_id: cellId, query, query_id: requestId }
      if (Object.keys(parameters).length > 0) body["parameters"] = parameters
      if (bookmark !== undefined) body["bookmark"] = bookmark

      const first = yield* post(body, query)
      if (first.bookmark !== null) yield* FiberRef.set(bookmarkRef, Option.some(first.bookmark))

      const asPage = (result: QueryResult & { readonly queryId: string | null }): Page => ({
        rows: result.rows,
        nextCursor: (result as { nextCursor?: string | number | null }).nextCursor ?? null,
        queryId: result.queryId
      })

      const rows = yield* followCursor(
        asPage(first),
        (cursor, queryId) =>
          post({ ...body, cursor, query_id: queryId }, query).pipe(Effect.map(asPage)),
        query
      )

      return { columns: first.columns, rows, bookmark: first.bookmark, readEpoch: first.readEpoch }
    })

  const query = (
    cypher: string,
    parameters: Params = {},
    options?: QueryOptions
  ): Effect.Effect<QueryResult, HydraError> =>
    send(cypher, parameters, options)

  /**
   * Claims a vertex's numeric id before the client reads or overwrites it.
   *
   * **In-process only, and that is the whole of what the engine allows.** Two
   * measured facts (2026-08-29, `palimpsest/hydradb:6a2fbb1`) close off a
   * pre-write remote probe:
   *
   *  - `MATCH (n {id: $id}) RETURN n.p` — *unlabelled* — returns **one row of
   *    nulls for an id that does not exist**, and echoes the requested id back
   *    as `n.id`, so nothing in the response separates "absent" from "present
   *    without a full key". Only a *labelled* match returns zero rows, and the
   *    label is exactly what a cross-label collision would differ in. `RETURN
   *    n`, `labels(n)`, `id(n)` and `count(n)` are all rejected — `RETURN`
   *    supports `<binding>.<property>` and `count(*)`, and `count(*)` counts
   *    the synthetic row.
   *  - It is one sequential round trip per vertex and, before the fix below,
   *    three per relationship. This ingest writes ~8 × 10⁵ vertices and
   *    ~2.5 × 10⁶ edges; at the engine's ~100 ms by-id read that is months of
   *    round trips for a graph the batched writes place in about an hour.
   *
   * So the guard that survives is the one that costs nothing: a process-local
   * map from numeric id to key, which fails a *different* key hashing to an
   * already-claimed id. The persisted `__palimpsest_full_key` is still written
   * by every merge and is still verified on **read** — `getById` projects it
   * beside the caller's properties and `verifyPathIdentity` checks every node
   * and relationship an `MSpaths` walk returns — so a collision between two
   * runs is caught the first time either record is read. What is *not* caught
   * is a collision that only ever exists on the write path of two separate
   * processes; at 53 bits and 10⁶ vertices that is ~5 × 10⁻⁵.
   */
  const claimVertexId = (key: string): Effect.Effect<number, HydraError> =>
    identityEffect(identities.claimVertex(key)).pipe(Effect.map((identity) => identity.numericId))

  /**
   * The same claim for a relationship key.
   *
   * A remote probe is not merely expensive here, it is unavailable: the engine
   * rejects `MATCH ()-[r {id: $id}]->()` outright — *"relationship pattern must
   * have exactly one type in Query engine"* — so the untyped form this used to
   * send was a 400 on every write.
   */
  const claimRelationshipId = (key: string): Effect.Effect<number, HydraError> =>
    identityEffect(identities.claimRelationship(key)).pipe(
      Effect.map((identity) => identity.numericId)
    )

  const verifyPathIdentity = (path: HydraPath): Effect.Effect<void, HydraError> =>
    Effect.gen(function* () {
      for (const node of path.nodes) {
        const storedKey = typeof node.properties[FULL_KEY_PROPERTY] === "string"
          ? node.properties[FULL_KEY_PROPERTY]
          : null
        if (storedKey !== null) yield* identityEffect(identities.claimVertex(storedKey))
        yield* identityEffect(
          verifyStoredGraphIdentity({
            kind: "vertex",
            numericId: node.id,
            requestedKey: storedKey ?? "",
            storedKey
          })
        )
      }
      for (const relationship of path.relationships) {
        const storedKey = typeof relationship.properties[FULL_KEY_PROPERTY] === "string"
          ? relationship.properties[FULL_KEY_PROPERTY]
          : null
        if (storedKey !== null) yield* identityEffect(identities.claimRelationship(storedKey))
        yield* identityEffect(
          verifyStoredGraphIdentity({
            kind: "relationship",
            // A relationship has *two* ids here and only one of them is ours.
            // The engine assigns its own, sequential (`1145` for the first
            // HAS_TURN of a fresh graph) and refuses `SET r.id`, so the
            // content-addressed `edgeId` lives in the `id` **property** that
            // the MERGE pattern set — verified here against the stored full key
            // exactly as a vertex's is. Checking `relationship.id` instead
            // compares a counter with a hash and fails on every path that
            // carries an edge, which is every path retrieval reads.
            numericId: contentAddressedId(relationship.properties),
            requestedKey: storedKey ?? "",
            storedKey
          })
        )
      }
    })

  /**
   * One vertex, read by its content-addressed id.
   *
   * This is the only cheap per-vertex read the engine offers. `MATCH (n:Label)
   * WHERE n.prop = $value` is a full label scan proportional to that label's
   * **store-wide** population (~75 µs/vertex measured: 4.4 s for one Claim
   * count at 58 k Claims, 18 s at the same graph a day later), while
   * `MATCH (n:Label {id: $id})` is ~100 ms whatever the store holds. Callers
   * pass the key string and never hash.
   *
   * There is no batched form: `UNWIND $rows AS row MATCH (n {id: row.id})
   * RETURN …` is refused with *"UNWIND batch supports one-hop relationships
   * only"*, and `WHERE n.id IN [...]` with *"WHERE currently supports boolean
   * combinations of property comparisons"*. Many vertices at once go through
   * `msPaths`, which is driven from its source values and is equally indexed.
   */
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
      const id = yield* claimVertexId(key)
      const projection = properties
        .concat(FULL_KEY_PROPERTY)
        .map((property) => `n.${requireIdentifier("property", property)} AS ${property}`)
        .join(", ")
      const result = yield* send(
        `MATCH (n:${label} {id: $id}) RETURN ${projection}`,
        { id },
        {}
      )
      const row = result.rows[0]
      if (row === undefined) return Option.none()
      const storedKey = typeof row[FULL_KEY_PROPERTY] === "string" ? row[FULL_KEY_PROPERTY] : null
      yield* identityEffect(
        verifyStoredGraphIdentity({ kind: "vertex", numericId: id, requestedKey: key, storedKey })
      )
      return Option.some(row)
    })

  /**
   * Sends one `UNWIND` write, halving the batch when the engine refuses it.
   *
   * The 1 000-row chunk is sized by admission control (1 024) and by how fast a
   * write *used to be* — 500 vertex upserts in ~55 ms. On the durable benchmark
   * runtime it is not: every write waits on a 1 ms WAL flush to an object store,
   * and under a four-user ingest a full chunk started crossing the engine's 30 s
   * runtime cap around the ninth user, losing the whole user each time.
   *
   * So the batch halves and *keeps* the smaller size for the rest of the write,
   * exactly as `deleteByKeys` does: one slow failure for the whole write rather
   * than one per chunk. It costs nothing when the node is fast, because nothing
   * fails.
   */
  const sendChunked = (
    statement: string,
    payload: ReadonlyArray<Readonly<Record<string, unknown>>>,
    maxRows: number
  ): Effect.Effect<number, HydraError> =>
    Effect.gen(function* () {
      let size = maxRows
      let chunks = chunkRows(payload, size)
      let index = 0
      let written = 0
      while (index < chunks.length) {
        const chunk = chunks[index]!
        const outcome = yield* send(statement, { rows: chunk }, {}).pipe(Effect.either)
        if (outcome._tag === "Right") {
          written += chunk.length
          index++
          continue
        }
        if (outcome.left._tag !== "HydraLimitError" || size === 1) {
          return yield* Effect.fail(outcome.left)
        }
        size = Math.max(1, Math.floor(size / 2))
        chunks = chunkRows(chunks.slice(index).flat(), size)
        index = 0
      }
      return written
    })

  const batchMerge = (
    label: string,
    rows: ReadonlyArray<VertexRow>
  ): Effect.Effect<number, HydraError> =>
    Effect.gen(function* () {
      if (rows.length === 0) return 0
      requireIdentifier("label", label)
      for (const row of rows) {
        if (Object.hasOwn(row.properties, FULL_KEY_PROPERTY)) {
          return yield* new HydraParseError({
            reason: `${FULL_KEY_PROPERTY} is reserved for Hydra identity verification`,
            code: "invalid_request",
            query: `<batchMerge ${label}>`
          })
        }
        yield* claimVertexId(row.key)
      }
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
        const assignments = [
          `n.${FULL_KEY_PROPERTY} = row.${FULL_KEY_PROPERTY}`,
          ...props.map((p) => `n.${requireIdentifier("property", p)} = row.${p}`)
        ]
          .join(", ")
        const statement = `UNWIND $rows AS row MERGE (n {id: row.id}) SET n:${label}, ${assignments}`
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

  const batchRel = (
    relType: string,
    rows: ReadonlyArray<RelRow>
  ): Effect.Effect<number, HydraError> =>
    Effect.gen(function* () {
      if (rows.length === 0) return 0
      requireIdentifier("relType", relType)
      for (const row of rows) {
        if (Object.hasOwn(row.properties ?? {}, FULL_KEY_PROPERTY)) {
          return yield* new HydraParseError({
            reason: `${FULL_KEY_PROPERTY} is reserved for Hydra identity verification`,
            code: "invalid_request",
            query: `<batchRel ${relType}>`
          })
        }
        yield* claimVertexId(row.srcKey)
        yield* claimVertexId(row.dstKey)
        yield* claimRelationshipId(`${row.srcKey}|${relType}|${row.dstKey}`)
      }
      const groups = groupBySignature(
        rows,
        (row) => `${row.srcLabel} | ${row.dstLabel} | ${signature(row.properties ?? {}).join(",")}`
      )
      let written = 0
      for (const [, group] of groups) {
        const first = group[0]!
        const props = signature(first.properties ?? {})
        requireIdentifier("srcLabel", first.srcLabel)
        requireIdentifier("dstLabel", first.dstLabel)
        // `SET r.id` is rejected by the engine ("cannot update relationship id"),
        // but the immutable full relationship key is always set and verified.
        const setClause = ` SET ${[
          `r.${FULL_KEY_PROPERTY} = row.${FULL_KEY_PROPERTY}`,
          ...props.map((p) => `r.${requireIdentifier("property", p)} = row.${p}`)
        ].join(", ")}`
        const statement =
          `UNWIND $rows AS row MATCH (s:${first.srcLabel} {id: row.s}), (d:${first.dstLabel} {id: row.d}) ` +
          `MERGE (s)-[r:${relType} {id: row.r}]->(d)${setClause}`
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
      for (const path of paths) yield* verifyPathIdentity(path)
      return paths
    })

  /**
   * Removes vertices and their edges.
   *
   * A `DETACH DELETE` costs whatever the vertex's degree happens to be, and a
   * high-`df` Token can sit on thousands of edges, so no fixed chunk size is
   * safe: 100 keys is instant for Claims and blows the 30 s cap for Tokens.
   * The batch therefore halves itself on a limit error until it fits, which
   * needs no knowledge of the caller's graph shape.
   */
  const deleteByKeys = (
    keys: ReadonlyArray<string>
  ): Effect.Effect<void, HydraError> =>
    Effect.gen(function* () {
      if (keys.length === 0) return
      const payload = keys.map((key) => ({ id: vertexId(key) }))

      // Each timeout costs a full 30 s, so the working size is halved and then
      // *kept* rather than re-discovered per batch: one or two slow failures for
      // the whole delete instead of one per chunk.
      let size = DELETE_ROWS_PER_CHUNK
      let index = 0
      while (index < payload.length) {
        const slice = payload.slice(index, index + size)
        const outcome = yield* send(
          "UNWIND $rows AS row MATCH (n {id: row.id}) DETACH DELETE n",
          { rows: slice },
          {}
        ).pipe(Effect.either)

        if (outcome._tag === "Right") {
          index += slice.length
          continue
        }
        // The edge-scan limit is a property of the whole store, not of this
        // batch, so halving cannot help — fail loudly instead of burning 30 s
        // per futile retry.
        if (
          outcome.left._tag !== "HydraLimitError" ||
          size === 1 ||
          /delete_vertex_scan_edges/.test(outcome.left.reason)
        ) {
          return yield* Effect.fail(outcome.left)
        }
        size = Math.max(1, Math.floor(size / 2))
      }
    })

  /** Runs one operation at the caller's explicit causal floor without leaking it to another request. */
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

/**
 * The one seam onto HydraDB. Everything the Cypher subset demands — inlined
 * string lists, MERGE-by-id upserts, body chunking, typed-value decoding,
 * request-scoped causal context, bookmark threading — is hidden behind these
 * operations.
 */
export class HydraClient extends Effect.Service<HydraClient>()("palimpsest/HydraClient", {
  effect: make
}) {}
