import { HttpApiBuilder } from "@effect/platform"
import { parseHaystackDate, type DatasetSession, type DatasetTurn } from "@palimpsest/dataset"
import type { HydraError } from "@palimpsest/hydra"
import {
  Ingest,
  Reader,
  Retrieve,
  Supersede,
  Transcript,
  readUserStats
} from "@palimpsest/palimpsest"
import { HydraClient } from "@palimpsest/hydra"
import { Effect, Option } from "effect"
import { createHash } from "node:crypto"
import { BadRequest, GraphError, NotFound, PalimpsestApi } from "./Api.js"

/**
 * The five endpoints.
 *
 * Two things are worth saying about what is *not* here. There is no auth and no
 * tenancy beyond the `uid` path segment — the spec lists both as non-goals, and
 * pretending otherwise in a demo server would be theatre. And there is no
 * bookmark plumbing in the request/response cycle: a single `HydraClient`
 * instance threads HydraDB's causal token through its own reads automatically,
 * so an ask that follows an ingest inside this process is read-your-writes
 * without the caller doing anything. The bookmark is returned anyway, because a
 * caller that wants to *prove* that is entitled to.
 */

/** HydraDB's own reason text is precise; propagate it rather than flattening it. */
const graphError = (error: HydraError): GraphError =>
  new GraphError({ reason: error.reason ?? String(error) })

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
    const hydra = yield* HydraClient

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
      .handle("ask", ({ path, payload }) =>
        Effect.gen(function* () {
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

          const receipt = {
            question: result.receipt.question,
            uid: result.receipt.uid,
            asOf: result.receipt.asOf,
            anchorTerms: result.receipt.anchorTerms,
            anchorsReachingClaims: result.receipt.anchorsReachingClaims,
            anchorsReachingNothing: result.receipt.anchorsReachingNothing,
            historical: result.receipt.historical,
            wantsCount: result.receipt.wantsCount,
            timeRef: result.receipt.timeRef,
            convergenceThreshold: result.receipt.convergenceThreshold,
            totalClaims: result.receipt.totalClaims,
            query1: result.receipt.query1,
            query1Paths: result.receipt.query1Paths,
            query2: result.receipt.query2,
            query2Paths: result.receipt.query2Paths,
            convergence: result.receipt.convergence
          }

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
      )
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
          return {
            skey: path.skey,
            asOf: urlParams.asOf ?? null,
            claims: claims.map((claim) => ({
              ckey: claim.ckey,
              text: claim.text,
              sessionOrd: claim.sessionOrd,
              tEvent: claim.tEvent,
              sid: claim.sid,
              supersededBy: claim.supersededBy,
              atSession: claim.atSession
            }))
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
