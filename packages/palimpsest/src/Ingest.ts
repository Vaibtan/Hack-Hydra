import type { LanguageModel } from "@effect/ai"
import type { Llm } from "@palimpsest/llm"
import type { DatasetQuestion, DatasetSession } from "@palimpsest/dataset"
import { HydraClient, type HydraError } from "@palimpsest/hydra"
import { Effect, Option } from "effect"
import { ClaimGraph } from "./ClaimGraph.js"
import type { SupersedeReport } from "./Supersede.js"
import { extractSession } from "./Extract.js"
import { sessionKey, slotKey } from "./Keys.js"
import { stems } from "./Tokenize.js"
import { Supersede } from "./Supersede.js"
import { Transcript } from "./Transcript.js"
import { EMPTY_STATS, readUserStats, writeUserStats, type UserStats } from "./User.js"

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

/** One session added to a history that already exists. */
export interface SessionIngestReport {
  readonly uid: string
  readonly sid: string
  readonly sessionOrd: number
  readonly claims: number
  readonly dropped: number
  readonly touchedSlots: ReadonlyArray<string>
  readonly supersessions: SupersedeReport
  readonly stats: UserStats
  /** True when this exact session was already in the graph and nothing was added. */
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

      // Every number `stats` used to read back with a store-wide label scan was
      // already in hand here — the write is what produced them. Recording them
      // on the `User` vertex is the whole of §2.1: an ingest that ends by
      // *counting* the graph it just wrote costs 30 s at scale and can fail a
      // user that was written perfectly.
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

  /**
   * Adds **one** session to a history that already exists.
   *
   * `ingestUser` can get away with a lot that this cannot. It extracts every
   * session, decides every canon at once, and then *overwrites* `Token.df` and
   * `Slot.n_claims` with the counts of its own run — which is right precisely
   * because its run is the whole history. One session arriving later has to add
   * to counts the rest of the history already contributed to, so it reads them
   * first (one `MSpaths` round trip each, not a scan) and writes them back.
   *
   * **Append-only.** `session_ord` is `User.n_sessions + 1`, so a session dated
   * before an existing one still sorts last. Inserting into the middle would
   * renumber every later session and invalidate every `at_session` on every
   * supersession edge — and edges here are only ever added. For the live demo,
   * where sessions arrive in the order they happen, append-only is the truth
   * rather than a compromise; a backdated import would need a re-ingest under a
   * fresh prefix.
   *
   * **Idempotent by session.** Re-posting the same session is a no-op: the
   * writes are content-addressed and would be, but the *counts* are not, so the
   * session vertex is checked by id first. Without that, posting twice would
   * inflate every `df` it touched and quietly change the idf of every later
   * question.
   */
  const ingestSession = (
    uid: string,
    session: Omit<DatasetSession, "sessionOrd">
  ): Effect.Effect<SessionIngestReport, HydraError, LanguageModel.LanguageModel | Llm> =>
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
      // Reconciled against what the graph already holds, exactly as a whole-user
      // ingest is — an existing canon always wins, so a session that says
      // "the moma" joins the entity a previous session wrote.
      const reconciled = claimGraph.reconcileAll(
        yield* claimGraph.readEntities(uid),
        extraction.claims
      )
      const write = yield* claimGraph.writeSession(uid, placed, extraction.claims, reconciled)

      // ---- derived counts, read then added to ------------------------------

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

      // ---- supersession, over the slots this session touched ---------------

      const contested = [...slotClaims]
        .filter(([, n]) => n >= 2)
        .map(([skey]) => {
          const slot = slotEntities.get(skey)
          return { skey, entityName: slot?.entityCanon ?? "", attr: slot?.attr ?? "" }
        })
        .sort((a, b) => a.skey.localeCompare(b.skey))
      const supersessions = yield* supersede.run(uid, contested)

      // ---- the User vertex -------------------------------------------------
      // Newly-created entities and slots only: a session that mentions an
      // entity the history already has adds no vertex, so counting its
      // mentions would drift the totals upward on every ingest.
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

export class Ingest extends Effect.Service<Ingest>()("palimpsest/Ingest", { effect: make }) {}
