import type { LanguageModel } from "@effect/ai"
import type { Llm } from "@palimpsest/llm"
import type { DatasetQuestion } from "@palimpsest/dataset"
import { HydraClient, type HydraError } from "@palimpsest/hydra"
import { Effect, Option } from "effect"
import { ClaimGraph, type UserStats } from "./ClaimGraph.js"
import type { SupersedeReport } from "./Supersede.js"
import { extractSession } from "./Extract.js"
import { slotKey } from "./Keys.js"
import { stems } from "./Tokenize.js"
import { Supersede } from "./Supersede.js"
import { Transcript } from "./Transcript.js"

/**
 * Ingest for one user, end to end.
 *
 * Sessions are *written* in `session_ord` order, but every canon decision is
 * made once up front over all of them, so a re-ingest reproduces the same graph
 * exactly rather than converging to it over two passes.
 *
 * **Extraction itself is order-independent**: a session is extracted knowing
 * nothing about the user, so the LLM call is keyed purely by the session's own
 * content and is shared by every user whose haystack contains it. LongMemEval_S
 * references 23 867 sessions of which 19 195 are distinct, so that sharing is
 * worth ~20 % of the extraction bill and, more importantly, makes a re-ingest
 * under a different uid free.
 */

export interface SessionProgress {
  readonly sid: string
  readonly sessionOrd: number
  readonly claims: number
  readonly dropped: number
  readonly touchedSlots: ReadonlyArray<string>
  readonly cached: boolean
}

export interface IngestReport {
  readonly uid: string
  readonly sessions: ReadonlyArray<SessionProgress>
  readonly stats: UserStats
  readonly supersessions: SupersedeReport
  readonly bookmark: Option.Option<string>
}

const make = Effect.gen(function* () {
  const transcript = yield* Transcript
  const claimGraph = yield* ClaimGraph
  const supersede = yield* Supersede
  const hydra = yield* HydraClient

  const ingestUser = (
    uid: string,
    question: DatasetQuestion,
    options?: { readonly onSession?: (progress: SessionProgress) => void }
  ): Effect.Effect<IngestReport, HydraError, LanguageModel.LanguageModel | Llm> =>
    Effect.gen(function* () {
      yield* transcript.ingest(uid, question.sessions)

      // Extraction is order-independent, so all sessions go out at once and the
      // Llm service's own semaphore decides how many are in flight. A
      // 48-session haystack is otherwise 48 serial round trips to the model,
      // which is the difference between three minutes and half an hour.
      const extractions = yield* Effect.forEach(
        question.sessions,
        (session) => extractSession(session),
        { concurrency: "unbounded" }
      )

      // Canons are decided once, for the whole ingest, against whatever the
      // graph already holds. Doing it per session as the graph grows makes the
      // first pass and a re-ingest disagree — session 1 would see only the
      // sessions before it the first time and all of them the second — and the
      // slot count would change on a re-run.
      const reconciled = claimGraph.reconcileAll(
        yield* claimGraph.readEntities(uid),
        extractions.flatMap((extraction) => extraction.claims)
      )

      const progress: Array<SessionProgress> = []
      const tokenDf = new Map<string, number>()
      const slotClaims = new Map<string, number>()
      const slotEntities = new Map<string, { entityCanon: string; attr: string }>()

      for (let i = 0; i < question.sessions.length; i++) {
        const session = question.sessions[i]!
        const extraction = extractions[i]!
        const write = yield* claimGraph.writeSession(uid, session, extraction.claims, reconciled)

        for (const stem of write.tokenHits) tokenDf.set(stem, (tokenDf.get(stem) ?? 0) + 1)
        for (const skey of write.slotFills) slotClaims.set(skey, (slotClaims.get(skey) ?? 0) + 1)
        for (const claim of extraction.claims) {
          if (claim.slot === null) continue
          const canon = reconciled.rename.get(claim.slot.entityCanon) ?? claim.slot.entityCanon
          slotEntities.set(slotKey(uid, canon, claim.slot.attr), {
            entityCanon: canon,
            attr: claim.slot.attr
          })
        }

        const step: SessionProgress = {
          sid: session.sid,
          sessionOrd: session.sessionOrd,
          claims: extraction.claims.length,
          dropped: extraction.dropped.length,
          touchedSlots: write.touchedSlots,
          cached: extraction.cached
        }
        progress.push(step)
        options?.onSession?.(step)
      }

      // Tokens that only NAME an entity hit no claim, but still need a df so
      // idf has a number for every anchor at query time.
      for (const stem of reconciled.entities.flatMap((entity) =>
        [entity.canon, ...entity.aliases].flatMap((name) => stems(name))
      )) {
        if (!tokenDf.has(stem)) tokenDf.set(stem, 0)
      }

      yield* claimGraph.writeCounts(uid, { tokenDf, slotClaims, slotEntities })

      // Supersession runs last, over the slots that ended up holding more than
      // one claim: whether a claim replaces another is only decidable against
      // the slot's whole ordered history.
      const contested = [...slotClaims]
        .filter(([, n]) => n >= 2)
        .map(([skey]) => {
          const slot = slotEntities.get(skey)
          return { skey, entityName: slot?.entityCanon ?? "", attr: slot?.attr ?? "" }
        })
        .sort((a, b) => a.skey.localeCompare(b.skey))
      const supersessions = yield* supersede.run(uid, contested)

      return {
        uid,
        sessions: progress,
        stats: yield* claimGraph.stats(uid),
        supersessions,
        bookmark: yield* hydra.lastBookmark
      }
    })

  const removeUser = (uid: string): Effect.Effect<void, HydraError> =>
    Effect.gen(function* () {
      yield* claimGraph.remove(uid)
      yield* transcript.remove(uid)
    })

  return { ingestUser, removeUser } as const
})

export class Ingest extends Effect.Service<Ingest>()("palimpsest/Ingest", { effect: make }) {}
