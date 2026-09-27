import { type HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder, type HttpApiGroup } from "effect/unstable/httpapi"
import { parseHaystackDate, type DatasetSession, type DatasetTurn } from "@palimpsest/dataset"
import { HydraMemory, type HydraError } from "@palimpsest/hydra"
import { type Llm } from "@palimpsest/llm"
import {
  Ingest,
  LegacyG3Adapter,
  QueryPrincipalProvider,
  Reader,
  Retrieve,
  SourceIndex,
  answerInSnapshot,
  ingestGenerationConfig,
  prepareDerivedIndexAssertions,
  sourceLinkedChainEvidence,
  unreadAnswer,
  type HydratedSpan,
  type SnapshotAskError,
  type SnapshotReadError,
  type V2Answer
} from "@palimpsest/palimpsest"
import { Effect, type Layer, Option } from "effect"
import { createHash } from "node:crypto"
import {
  BadRequest,
  EvidenceSpan,
  GraphError,
  NotFound,
  PalimpsestApi,
  type AskResponse
} from "./Api.js"
import { projectPlan } from "./ReceiptProjection.js"

const graphError = (error: HydraError): GraphError =>
  new GraphError({ reason: error.reason ?? String(error) })

/**
 * Snapshot read failures to stable public errors. Unknown scopes stay 404
 * like before; known scopes without an active snapshot, corrupt pointers,
 * and scope/graph mismatches are 503s that never read as an absence.
 * Manifest internals stay opaque; only safe validation reasons pass through.
 */
export const snapshotFailure = (
  error: SnapshotAskError | SnapshotReadError
): GraphError | NotFound => {
  switch (error._tag) {
    case "MemoryScopeNotFound":
      return new NotFound({ what: "user", key: `${error.tenant}/${error.uid}` })
    case "NoActiveSnapshot":
      return new GraphError({ reason: `no active snapshot for ${error.tenant}/${error.uid}` })
    case "ActiveSnapshotCorrupt":
      return new GraphError({
        reason: `active snapshot ${error.snapshotId} is corrupt: ${error.reason}`
      })
    case "SnapshotScopeViolation":
      return new GraphError({ reason: `snapshot scope violation: ${error.reason}` })
    case "SnapshotGraphMismatch":
      return new GraphError({ reason: `snapshot graph mismatch: ${error.reason}` })
    case "HydraEngineError":
    case "HydraParseError":
    case "HydraLimitError":
    case "HydraUnavailable":
      return new GraphError({ reason: error.reason })
    case "HydraIdentityIntegrityError":
      return new GraphError({ reason: error.message })
    default:
      return new GraphError({ reason: "memory scope is unavailable" })
  }
}

/**
 * Public evidence contains verbatim source bytes plus an immutable source
 * locator. Derived claim text remains private to retrieval.
 */
export const toPublicEvidence = (
  spans: ReadonlyArray<HydratedSpan>
): ReadonlyArray<typeof EvidenceSpan.Type> =>
  spans.map((span) => {
    const provenance = span.provenance
    if (provenance === undefined) {
      throw new Error(`snapshot evidence ${span.id} was missing immutable source provenance`)
    }
    return {
      ckey: span.ckey,
      id: span.id,
      sid: span.sid,
      sessionOrd: span.sessionOrd,
      sessionDate: span.sessionDate,
      tEvent: span.tEvent,
      speaker: span.speaker,
      status: span.status,
      atSession: span.atSession,
      source: {
        snapshotId: provenance.snapshotId,
        commitId: provenance.commitId,
        sourceDigest: provenance.sourceDigest,
        logicalSessionId: provenance.logicalSessionId,
        sourceTurnKey: provenance.sourceTurnKey,
        turnIdx: span.turnIdx,
        offsetStart: span.cs,
        offsetEnd: span.ce
      },
      excerpt: span.excerpt,
      highlight: span.highlight
    }
  })

const sourceIndexState = (
  state: "RECEIVED" | "SOURCE_DURABLE" | "INDEXED" | "ENRICHED" | "CONSOLIDATED" | "COMMITTED"
): "INDEXED" | "ENRICHED" | "CONSOLIDATED" | "COMMITTED" => {
  if (state === "INDEXED" || state === "ENRICHED" || state === "CONSOLIDATED" || state === "COMMITTED") {
    return state
  }
  throw new Error(`Source index operation returned before INDEXED: ${state}`)
}

/** A content-addressed session id for a session the caller did not name. */
const sidFor = (date: string, turns: ReadonlyArray<{ readonly content: string }>): string =>
  `live-${createHash("sha1")
    .update(date, "utf8")
    .update(turns.map((turn) => turn.content).join(""), "utf8")
    .digest("hex")
    .slice(0, 12)}`

export const toAskResponse = (
  answered: V2Answer,
  evidence: ReadonlyArray<HydratedSpan>,
  started: number
): typeof AskResponse.Type => {
  const read = answered.read
  return {
    verdict: answered.verdict,
    reason: answered.reason,
    answer: answered.verdict === "ABSENT" || read === null ? null : read.answer,
    notInMemory: answered.verdict === "ABSENT" || (read !== null && read.notInMemory),
    reasoning: read === null ? "" : read.reasoning,
    citedIds: read === null ? [] : read.citedIds,
    evidence: toPublicEvidence(evidence),
    receipt: answered.ask.receipt,
    plan: projectPlan(answered),
    hash: answered.hash,
    latencyMs: Date.now() - started
  }
}

type UserHandlerServices =
  | HydraMemory
  | Ingest
  | LegacyG3Adapter
  | QueryPrincipalProvider
  | Reader
  | Retrieve
  | SourceIndex

export const UsersLive: Layer.Layer<
  HttpApiGroup.Service<"palimpsest", "users">,
  BadRequest | GraphError | NotFound,
  | UserHandlerServices
  | HttpRouter.Request.From<"Requires", UserHandlerServices | Llm>
> = HttpApiBuilder.group(PalimpsestApi, "users", (handlers) =>
  Effect.gen(function* () {
    const ingest = yield* Ingest
    const retrieve = yield* Retrieve
    const reader = yield* Reader
    const legacy = yield* LegacyG3Adapter
    const principals = yield* QueryPrincipalProvider
    const sourceIndex = yield* SourceIndex
    const hydra = yield* HydraMemory
    const generation = yield* ingestGenerationConfig.pipe(
      Effect.mapError(
        () => new GraphError({ reason: "immutable source-index configuration is unavailable" })
      )
    )

    const requireUser = (uid: string) =>
      legacy.userStats(uid).pipe(
        Effect.mapError(graphError),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new NotFound({ what: "user", key: uid })),
            onSome: (stats) => Effect.succeed(stats)
          })
        )
      )

    const isolateRequest = (bookmark?: string) =>
      <A, E, R>(operation: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
        hydra.withCausalBookmark(bookmark, operation)

    return handlers
      .handle("ingestSession", ({ params, payload }) =>
        Effect.gen(function* () {
          if (payload.turns.length === 0) {
            return yield* new BadRequest({ reason: "a session needs at least one turn" })
          }
          const date = yield* Effect.try({
            try: () => parseHaystackDate(payload.date),
            catch: () =>
              new BadRequest({
                reason: `date must look like "2023/04/10 (Mon) 17:50", got ${JSON.stringify(payload.date)}`
              })
          })

          const sid = payload.sid ?? sidFor(payload.date, payload.turns)
          const turns: ReadonlyArray<DatasetTurn> = payload.turns.map((turn, turnIdx) => ({
            turnIdx,
            role: turn.role,
            text: turn.content,
            hasAnswer: false
          }))
          const session: Omit<DatasetSession, "sessionOrd"> = { sid, key: sid, date, turns }

          const report = yield* ingest.ingestSession(params.uid, session).pipe(
            Effect.mapError(graphError)
          )
          yield* legacy.retrieve.forgetUser(params.uid)

          return {
            uid: report.uid,
            sid: report.sid,
            sessionOrd: report.sessionOrd,
            claims: report.claims,
            dropped: report.dropped,
            touchedSlots: report.touchedSlots,
            supersessions: report.supersessions.edges,
            alreadyPresent: report.alreadyPresent,
            bookmark: Option.getOrNull(report.bookmark),
            stats: report.stats
          }
        }).pipe(isolateRequest())
      )
      .handle("sourceIndexSession", ({ params, payload }) =>
        Effect.gen(function* () {
          if (payload.turns.length === 0) {
            return yield* new BadRequest({ reason: "a session needs at least one turn" })
          }
          const date = yield* Effect.try({
            try: () => parseHaystackDate(payload.date),
            catch: () =>
              new BadRequest({
                reason: `date must look like "2023/04/10 (Mon) 17:50", got ${JSON.stringify(payload.date)}`
              })
          })
          const sid = payload.sid ?? sidFor(payload.date, payload.turns)
          const session: DatasetSession = {
            sid,
            key: sid,
            sessionOrd: 0,
            date,
            turns: payload.turns.map((turn, turnIdx) => ({
              turnIdx,
              role: turn.role,
              text: turn.content,
              hasAnswer: false
            }))
          }
          const result = yield* sourceIndex.indexSession({
            tenant: "default",
            uid: params.uid,
            session,
            generation
          }).pipe(Effect.mapError((error) => new GraphError({ reason: error.message })))

          return {
            uid: result.revision.uid,
            sid: session.sid,
            commitId: result.revision.commitId,
            sourceDigest: result.revision.sourceDigest,
            extractionGeneration: result.revision.extractionGeneration,
            indexGeneration: generation.indexGeneration.id,
            state: sourceIndexState(result.revision.state),
            alreadyAtTarget: result.alreadyAtTarget,
            queryVisible: false as const
          }
        }).pipe(isolateRequest())
      )
      .handle("ask", ({ params, payload }) => {
        const operation = Effect.gen(function* () {
          const principal = yield* principals.currentPrincipal.pipe(
            Effect.mapError((error) => new GraphError({ reason: error.message }))
          )
          const started = Date.now()
          const questionDate = payload.questionDate ?? "unknown"
          const options = {
            questionDate,
            ...(payload.asOf !== undefined && { asOf: payload.asOf }),
            ...(payload.perspective !== undefined && { perspective: payload.perspective }),
            ...(payload.historical !== undefined && { historical: payload.historical }),
            profile: payload.profile ?? ("fast" as const)
          }

          if (payload.retrieveOnly === true) {
            const ask = yield* retrieve
              .ask(principal, params.uid, payload.question, options)
              .pipe(Effect.mapError(snapshotFailure))
            const evidence =
              ask.verdict !== "ANSWER"
                ? []
                : yield* reader.hydrate(ask.query, ask.evidence).pipe(Effect.mapError(snapshotFailure))
            return toAskResponse(unreadAnswer(ask), evidence, started)
          }

          const answered = yield* answerInSnapshot(
            retrieve,
            reader,
            principal,
            params.uid,
            payload.question,
            questionDate,
            options
          ).pipe(Effect.mapError(snapshotFailure))
          return toAskResponse(answered, answered.read === null ? [] : answered.read.spans, started)
        })
        return isolateRequest(payload.bookmark)(operation)
      })
      .handle("sessions", ({ params }) =>
        legacy.readSessions(params.uid).pipe(Effect.mapError(graphError), isolateRequest())
      )
      .handle("slot", ({ params, query }) =>
        Effect.gen(function* () {
          yield* requireUser(params.uid)
          const claims = yield* legacy
            .slotChain(params.uid, params.skey, query.asOf)
            .pipe(Effect.mapError(graphError))
          if (claims.length === 0) {
            return yield* new NotFound({ what: "slot", key: params.skey })
          }
          const sourceSpans = yield* legacy.reader
            .hydrate(sourceLinkedChainEvidence(claims))
            .pipe(Effect.mapError(graphError))
          const assertions = prepareDerivedIndexAssertions(claims, sourceSpans)
          if (assertions._tag === "Failure") {
            return yield* new GraphError({
              reason: "derived index assertions are unavailable without linked verbatim source revisions"
            })
          }
          return {
            skey: params.skey,
            asOf: query.asOf ?? null,
            assertions: assertions.success
          }
        }).pipe(isolateRequest())
      )
      .handle("stats", ({ params }) =>
        Effect.gen(function* () {
          const stats = yield* requireUser(params.uid)
          const contested = yield* legacy
            .contestedSlots(params.uid)
            .pipe(Effect.mapError(graphError))
          return { uid: params.uid, ...stats, contested }
        }).pipe(isolateRequest())
      )
      .handle("warm", ({ params }) =>
        Effect.gen(function* () {
          yield* requireUser(params.uid)
          const report = yield* legacy.warm(params.uid).pipe(Effect.mapError(graphError))
          if (Option.isNone(report)) {
            return yield* new NotFound({ what: "user", key: params.uid })
          }
          const it = report.value
          return {
            uid: params.uid,
            entities: it.entities,
            slots: it.slots,
            sessions: it.sessions,
            tokens: it.tokens,
            slotClaims: it.slotClaims,
            turns: it.turns,
            failed: it.failed,
            truncated: it.truncated,
            ms: it.ms
          }
        }).pipe(isolateRequest())
      )
  })
)
