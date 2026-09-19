import type { Llm } from "@palimpsest/llm"
import type { DatasetQuestion, DatasetSession } from "@palimpsest/dataset"
import { HydraClient, type HydraError } from "@palimpsest/hydra"
import { Context, Effect, Layer, Option } from "effect"
import { ClaimGraph } from "./ClaimGraph.js"
import type { SupersedeReport } from "./Supersede.js"
import { extractSession } from "./Extract.js"
import { sessionKey, slotKey } from "./Keys.js"
import { stems } from "./Tokenize.js"
import { Supersede } from "./Supersede.js"
import { Transcript } from "./Transcript.js"
import { EMPTY_STATS, readUserStats, writeUserStats, type UserStats } from "./User.js"

export interface SessionProgress {
  readonly sid: string
  readonly sessionOrd: number
  readonly claims: number
  readonly dropped: number
  readonly touchedSlots: ReadonlyArray<string>
  readonly cached: boolean
}

export interface SessionIngestReport {
  readonly uid: string
  readonly sid: string
  readonly sessionOrd: number
  readonly claims: number
  readonly dropped: number
  readonly touchedSlots: ReadonlyArray<string>
  readonly supersessions: SupersedeReport
  readonly stats: UserStats
  readonly alreadyPresent: boolean
  readonly bookmark: Option.Option<string>
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
  ): Effect.Effect<IngestReport, HydraError, Llm> =>
    Effect.gen(function* () {
      yield* transcript.ingest(uid, question.sessions)

      const extractions = yield* Effect.forEach(
        question.sessions,
        (session) => extractSession(session),
        { concurrency: "unbounded" }
      )

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

      for (const stem of reconciled.entities.flatMap((entity) =>
        [entity.canon, ...entity.aliases].flatMap((name) => stems(name))
      )) {
        if (!tokenDf.has(stem)) tokenDf.set(stem, 0)
      }

      yield* claimGraph.writeCounts(uid, { tokenDf, slotClaims, slotEntities })

      const contested = [...slotClaims]
        .filter(([, n]) => n >= 2)
        .map(([skey]) => {
          const slot = slotEntities.get(skey)
          return { skey, entityName: slot?.entityCanon ?? "", attr: slot?.attr ?? "" }
        })
        .sort((a, b) => a.skey.localeCompare(b.skey))
      const supersessions = yield* supersede.run(uid, contested)

      const stats: UserStats = {
        claims: extractions.reduce((n, extraction) => n + extraction.claims.length, 0),
        entities: reconciled.entities.length,
        slots: slotEntities.size,
        tokens: tokenDf.size,
        sessions: question.sessions.length,
        turns: question.sessions.reduce((n, session) => n + session.turns.length, 0),
        supersessions: supersessions.edges,
        contestedSlots: contested.length
      }
      yield* writeUserStats(hydra, uid, stats)

      return {
        uid,
        sessions: progress,
        stats,
        supersessions,
        bookmark: yield* hydra.lastBookmark
      }
    })

  const ingestSession = (
    uid: string,
    session: Omit<DatasetSession, "sessionOrd">
  ): Effect.Effect<SessionIngestReport, HydraError, Llm> =>
    Effect.gen(function* () {
      const before = yield* readUserStats(hydra, uid).pipe(
        Effect.map(Option.getOrElse((): UserStats => EMPTY_STATS))
      )

      const existing = yield* hydra.getById("Session", sessionKey(uid, session.key), [
        "sess",
        "session_ord"
      ])
      if (existing._tag === "Some") {
        return {
          uid,
          sid: session.sid,
          sessionOrd: Number(existing.value["session_ord"] ?? 0),
          claims: 0,
          dropped: 0,
          touchedSlots: [],
          supersessions: { slotsExamined: 0, slotsContested: 0, edges: 0, cachedDecisions: 0 },
          stats: before,
          alreadyPresent: true,
          bookmark: yield* hydra.lastBookmark
        }
      }

      const placed: DatasetSession = { ...session, sessionOrd: before.sessions + 1 }
      yield* transcript.ingest(uid, [placed])

      const extraction = yield* extractSession(placed)
      const reconciled = claimGraph.reconcileAll(
        yield* claimGraph.readEntities(uid),
        extraction.claims
      )
      const write = yield* claimGraph.writeSession(uid, placed, extraction.claims, reconciled)

      const addedDf = new Map<string, number>()
      for (const stem of write.tokenHits) addedDf.set(stem, (addedDf.get(stem) ?? 0) + 1)
      const currentDf = yield* claimGraph.readTokenDf(uid, [...addedDf.keys()])

      const addedSlot = new Map<string, number>()
      for (const skey of write.slotFills) addedSlot.set(skey, (addedSlot.get(skey) ?? 0) + 1)
      const currentSlot = yield* claimGraph.readSlotClaimCounts([...addedSlot.keys()])

      const slotEntities = new Map<string, { entityCanon: string; attr: string }>()
      for (const claim of extraction.claims) {
        if (claim.slot === null) continue
        const canon = reconciled.rename.get(claim.slot.entityCanon) ?? claim.slot.entityCanon
        slotEntities.set(slotKey(uid, canon, claim.slot.attr), {
          entityCanon: canon,
          attr: claim.slot.attr
        })
      }

      const tokenDf = new Map<string, number>()
      for (const [stem, added] of addedDf) tokenDf.set(stem, (currentDf.get(stem) ?? 0) + added)
      const slotClaims = new Map<string, number>()
      for (const [skey, added] of addedSlot) {
        slotClaims.set(skey, (currentSlot.get(skey) ?? 0) + added)
      }

      yield* claimGraph.writeCounts(uid, { tokenDf, slotClaims, slotEntities })

      const contested = [...slotClaims]
        .filter(([, n]) => n >= 2)
        .map(([skey]) => {
          const slot = slotEntities.get(skey)
          return { skey, entityName: slot?.entityCanon ?? "", attr: slot?.attr ?? "" }
        })
        .sort((a, b) => a.skey.localeCompare(b.skey))
      const supersessions = yield* supersede.run(uid, contested)

      const newEntities = reconciled.entities.length - before.entities
      const newSlots = [...slotClaims.keys()].filter(
        (skey) => (currentSlot.get(skey) ?? 0) === 0
      ).length
      const newTokens = [...addedDf.keys()].filter(
        (stem) => (currentDf.get(stem) ?? 0) === 0
      ).length

      const stats: UserStats = {
        claims: before.claims + extraction.claims.length,
        entities: before.entities + Math.max(0, newEntities),
        slots: before.slots + newSlots,
        tokens: before.tokens + newTokens,
        sessions: before.sessions + 1,
        turns: before.turns + placed.turns.length,
        supersessions: before.supersessions + supersessions.edges,
        contestedSlots: before.contestedSlots + contested.filter(
          (slot) => (currentSlot.get(slot.skey) ?? 0) < 2
        ).length
      }
      yield* writeUserStats(hydra, uid, stats)

      return {
        uid,
        sid: session.sid,
        sessionOrd: placed.sessionOrd,
        claims: extraction.claims.length,
        dropped: extraction.dropped.length,
        touchedSlots: write.touchedSlots,
        supersessions,
        stats,
        alreadyPresent: false,
        bookmark: yield* hydra.lastBookmark
      }
    })

  const removeUser = (uid: string): Effect.Effect<void, HydraError> =>
    Effect.gen(function* () {
      yield* claimGraph.remove(uid)
      yield* transcript.remove(uid)
    })

  return { ingestUser, ingestSession, removeUser } as const
})

export type Ingest = Effect.Success<typeof make>
const IngestTag = Context.Service<Ingest>("palimpsest/Ingest")
export const Ingest = Object.assign(IngestTag, { layer: Layer.effect(IngestTag, make) })
