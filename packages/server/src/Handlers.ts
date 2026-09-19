import { type HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder, type HttpApiGroup } from "effect/unstable/httpapi"
import { parseHaystackDate, type DatasetSession, type DatasetTurn } from "@palimpsest/dataset"
import { HydraClient, type HydraError } from "@palimpsest/hydra"
import { type Llm } from "@palimpsest/llm"
import {
  Ingest,
  Reader,
  Retrieve,
  Supersede,
  Transcript,
  SourceIndex,
  answerV2,
  ingestGenerationConfig,
  prepareDerivedIndexAssertions,
  readUserStats,
  unreadAnswer,
  warmUser,
  sourceLinkedChainEvidence,
  type HydratedSpan,
  type V2Answer
} from "@palimpsest/palimpsest"
import { Effect, type Layer, Option } from "effect"
import { createHash } from "node:crypto"
import { BadRequest, GraphError, NotFound, PalimpsestApi, type AskResponse } from "./Api.js"
import { projectPlan } from "./ReceiptProjection.js"

const graphError = (error: HydraError): GraphError =>
  new GraphError({ reason: error.reason ?? String(error) })

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
    .update(turns.map((turn) => turn.content).join(""), "utf8")
    .digest("hex")
    .slice(0, 12)}`

const toAskResponse = (
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
    evidence,
    receipt: answered.ask.receipt,
    plan: projectPlan(answered),
    hash: answered.hash,
    latencyMs: Date.now() - started
  }
}

type UserHandlerServices =
  | HydraClient
  | Ingest
  | Reader
  | Retrieve
  | SourceIndex
  | Supersede
  | Transcript

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
    const supersede = yield* Supersede
    const transcript = yield* Transcript
    const sourceIndex = yield* SourceIndex
    const hydra = yield* HydraClient
    const generation = yield* ingestGenerationConfig.pipe(
      Effect.mapError(
        () => new GraphError({ reason: "immutable source-index configuration is unavailable" })
      )
    )

    const requireUser = (uid: string) =>
      readUserStats(hydra, uid).pipe(
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
          yield* retrieve.forgetUser(params.uid)

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
          yield* requireUser(params.uid)
          const started = Date.now()
          const questionDate = payload.questionDate ?? "unknown"
          const options = {
            questionDate,
            ...(payload.asOf !== undefined && { asOf: payload.asOf }),
            ...(payload.historical !== undefined && { historical: payload.historical }),
            profile: payload.profile ?? ("fast" as const)
          }

          if (payload.retrieveOnly === true) {
            const ask = yield* retrieve
              .ask(params.uid, payload.question, options)
              .pipe(Effect.mapError(graphError))
            const evidence =
              ask.verdict === "ABSENT"
                ? []
                : yield* reader.hydrate(ask.evidence).pipe(Effect.mapError(graphError))
            return toAskResponse(unreadAnswer(ask), evidence, started)
          }

          const answered = yield* answerV2(
            retrieve,
            reader,
            params.uid,
            payload.question,
            questionDate,
            options
          ).pipe(Effect.mapError(graphError))
          return toAskResponse(answered, answered.read === null ? [] : answered.read.spans, started)
        })
        return isolateRequest(payload.bookmark)(operation)
      })
      .handle("sessions", ({ params }) =>
        transcript.readSessions(params.uid).pipe(Effect.mapError(graphError), isolateRequest())
      )
      .handle("slot", ({ params, query }) =>
        Effect.gen(function* () {
          yield* requireUser(params.uid)
          const claims = yield* supersede
            .chain(params.uid, params.skey, query.asOf)
            .pipe(Effect.mapError(graphError))
          if (claims.length === 0) {
            return yield* new NotFound({ what: "slot", key: params.skey })
          }
          const sourceSpans = yield* reader
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
          const contested = yield* supersede
            .contestedSlots(params.uid)
            .pipe(Effect.mapError(graphError))
          return { uid: params.uid, ...stats, contested }
        }).pipe(isolateRequest())
      )
      .handle("warm", ({ params }) =>
        Effect.gen(function* () {
          yield* requireUser(params.uid)
          const report = yield* warmUser(hydra, params.uid).pipe(Effect.mapError(graphError))
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
