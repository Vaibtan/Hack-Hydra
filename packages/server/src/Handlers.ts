import { HttpApiBuilder } from "@effect/platform"
import { parseHaystackDate, type DatasetSession, type DatasetTurn } from "@palimpsest/dataset"
import type { HydraError } from "@palimpsest/hydra"
import {
  Ingest,
  Reader,
  Retrieve,
  Supersede,
  Transcript,
  SourceIndex,
  ingestGenerationConfig,
  prepareDerivedIndexAssertions,
  readUserStats,
  sourceLinkedChainEvidence
} from "@palimpsest/palimpsest"
import { HydraClient } from "@palimpsest/hydra"
import { Effect, Option } from "effect"
import { createHash } from "node:crypto"
import { BadRequest, GraphError, NotFound, PalimpsestApi } from "./Api.js"
import { projectRetrievalReceipt } from "./ReceiptProjection.js"

/**
 * The five endpoints.
 *
 * Two things are worth saying about what is *not* here. There is no auth and no
 * tenancy beyond the `uid` path segment — the spec lists both as non-goals, and
 * pretending otherwise in a demo server would be theatre. Causal bookmarks are
 * caller-held: an ask that supplies the opaque token returned by ingest runs at
 * that token's floor; an ask without one makes no read-your-writes claim.
 */

/** HydraDB's own reason text is precise; propagate it rather than flattening it. */
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

/**
 * A session id for content the caller did not name. Content-addressed, so
 * posting the same session twice is recognised as the same session and the
 * second post is a no-op rather than a duplicate history.
 */
const sidFor = (date: string, turns: ReadonlyArray<{ readonly content: string }>): string =>
  `live-${createHash("sha1")
    .update(date, "utf8")
    .update(turns.map((turn) => turn.content).join(""), "utf8")
    .digest("hex")
    .slice(0, 12)}`

export const UsersLive = HttpApiBuilder.group(PalimpsestApi, "users", (handlers) =>
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

    /** Refuses to answer for a user that was never indexed, rather than abstaining. */
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

    return handlers
      .handle("ingestSession", ({ path, payload }) =>
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
          // `sessionOrd` is decided by `ingestSession` from the User vertex, so
          // it is omitted here rather than guessed.
          const session: Omit<DatasetSession, "sessionOrd"> = { sid, key: sid, date, turns }

          const report = yield* ingest.ingestSession(path.uid, session).pipe(
            Effect.mapError(graphError)
          )
          // The idf denominator this process memoised for that user is now one
          // session out of date, and the live demo's whole point is that the
          // next ask sees what was just written.
          yield* retrieve.forgetUser(path.uid)

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
        })
      )
      .handle("sourceIndexSession", ({ path, payload }) =>
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
            // The manifest atomically assigns the real per-user ordinal. This
            // placeholder is excluded from source identity and never persisted.
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
            uid: path.uid,
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
        })
      )
      .handle("ask", ({ path, payload }) => {
        const operation = Effect.gen(function* () {
          yield* requireUser(path.uid)
          const started = Date.now()
          const questionDate = payload.questionDate ?? "unknown"

          const result = yield* retrieve
            .ask(path.uid, payload.question, {
              ...(payload.questionDate === undefined ? {} : { questionDate: payload.questionDate }),
              ...(payload.asOf === undefined ? {} : { asOf: payload.asOf }),
              ...(payload.historical === undefined ? {} : { historical: payload.historical })
            })
            .pipe(Effect.mapError(graphError))

          const receipt = projectRetrievalReceipt(result.receipt)

          // A structural ABSENT has no evidence by construction — that is the
          // claim it makes — so there is nothing for the reader to read.
          if (result.verdict === "ABSENT" || payload.retrieveOnly === true) {
            const spans =
              result.verdict === "ABSENT"
                ? []
                : yield* reader.hydrate(result.evidence).pipe(Effect.mapError(graphError))
            return {
              verdict: result.verdict,
              reason: result.reason,
              answer: null,
              notInMemory: result.verdict === "ABSENT",
              reasoning: "",
              citedIds: [],
              premiseSupported: null,
              premiseNote: "",
              evidence: spans,
              receipt,
              hash: result.hash,
              latencyMs: Date.now() - started
            }
          }

          const answer = yield* reader
            .read(payload.question, questionDate, result.evidence, {
              ...(payload.premiseCheck === undefined ? {} : { premiseCheck: payload.premiseCheck })
            })
            .pipe(Effect.mapError(graphError))

          return {
            verdict: result.verdict,
            reason: result.reason,
            answer: answer.answer,
            notInMemory: answer.notInMemory,
            reasoning: answer.reasoning,
            citedIds: answer.citedIds,
            premiseSupported: answer.premiseSupported,
            premiseNote: answer.premiseNote,
            evidence: answer.spans,
            receipt,
            hash: result.hash,
            latencyMs: Date.now() - started
          }
        })
        return payload.bookmark === undefined
          ? operation
          : hydra.withCausalBookmark(payload.bookmark, operation)
      })
      .handle("sessions", ({ path }) =>
        transcript.readSessions(path.uid).pipe(Effect.mapError(graphError))
      )
      .handle("slot", ({ path, urlParams }) =>
        Effect.gen(function* () {
          yield* requireUser(path.uid)
          const claims = yield* supersede
            .chain(path.uid, path.skey, urlParams.asOf)
            .pipe(Effect.mapError(graphError))
          if (claims.length === 0) {
            return yield* new NotFound({ what: "slot", key: path.skey })
          }
          const sourceSpans = yield* reader
            .hydrate(sourceLinkedChainEvidence(claims))
            .pipe(Effect.mapError(graphError))
          const assertions = prepareDerivedIndexAssertions(claims, sourceSpans)
          if (assertions._tag === "Left") {
            return yield* new GraphError({
              reason: "derived index assertions are unavailable without linked verbatim source revisions"
            })
          }
          return {
            skey: path.skey,
            asOf: urlParams.asOf ?? null,
            assertions: assertions.right
          }
        })
      )
      .handle("stats", ({ path }) =>
        Effect.gen(function* () {
          const stats = yield* requireUser(path.uid)
          const contested = yield* supersede
            .contestedSlots(path.uid)
            .pipe(Effect.mapError(graphError))
          return { uid: path.uid, ...stats, contested }
        })
      )
  })
)
