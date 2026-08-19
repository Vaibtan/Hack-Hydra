import type { DatasetSession } from "@palimpsest/dataset"
import { HydraClient, type HydraError, type Scalar } from "@palimpsest/hydra"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import { reconcile, type Reconciled } from "./Canon.js"
import type { ExtractedClaim, ExtractedEntity } from "./Extract.js"
import { claimKey, claimKind, entityKey, slotKey, tokenKey, turnKey } from "./Keys.js"
import { claimTokens } from "./Tokenize.js"
import { EMPTY_STATS, linkToUser, readUserStats, readUserVertices, type UserStats } from "./User.js"

/**
 * Writing the claim graph.
 *
 * Every vertex is keyed by content, so the whole write is idempotent: re-running
 * a session's ingest is `MERGE` by the same ids and `SET` the same values. That
 * is what lets ingest be retried, resumed, or re-run after a prompt change
 * without a reset step.
 */

/**
 * HydraDB properties are scalars — there is no list type — so an entity's
 * aliases are stored as one string joined by the ASCII unit separator, which
 * cannot occur in the dataset's text.
 */
const ALIAS_SEPARATOR = "\u001f"

/** A Claim's identity is its text plus the exact Span it points at. */
export const claimDigest = (claim: ExtractedClaim, sid: string): string =>
  createHash("sha1")
    .update(claim.text, "utf8")
    .update(" | ", "utf8")
    .update(`${sid}|${claim.span.turnIdx}|${claim.span.cs}|${claim.span.ce}`, "utf8")
    .digest("hex")

export interface WrittenClaim {
  readonly ckey: string
  readonly skey: string | null
  readonly sessionOrd: number
}

export interface SessionWrite {
  readonly claims: ReadonlyArray<WrittenClaim>
  readonly entities: ReadonlyArray<ExtractedEntity>
  /** Slots this session put a claim into — the input to the supersession pass. */
  readonly touchedSlots: ReadonlyArray<string>
  readonly tokens: number
  /** One entry per (claim, token) pair written — summed into `Token.df`. */
  readonly tokenHits: ReadonlyArray<string>
  /** One entry per claim that filled a slot — summed into `Slot.n_claims`. */
  readonly slotFills: ReadonlyArray<string>
}

export type { UserStats } from "./User.js"

const make = Effect.gen(function* () {
  const hydra = yield* HydraClient

  /**
   * The user's entities, as the graph currently holds them — walked from the
   * `User` root over `HAS_ENTITY`.
   *
   * `MATCH (e:Entity) WHERE e.uid = $uid` measured **4.9 s** at 26 users and is
   * proportional to every Entity in the store, so at the 500-user scale it
   * exceeds the engine's 30 s cap — on the read that opens *every* ingest.
   * `MSpaths` is driven from one indexed source value and does not care how
   * big the store is.
   */
  const readEntities = (uid: string): Effect.Effect<ReadonlyArray<ExtractedEntity>, HydraError> =>
    readUserVertices(hydra, uid, "HAS_ENTITY").pipe(
      Effect.map((rows) =>
        rows
          .map((row) => ({
            canon: String(row["name"] ?? ""),
            etype: String(row["etype"] ?? "topic") as ExtractedEntity["etype"],
            // HydraDB has no list type, so aliases travel as a delimited string.
            aliases: String(row["aliases"] ?? "")
              .split(ALIAS_SEPARATOR)
              .filter((alias) => alias !== "")
          }))
          .filter((entity) => entity.canon !== "")
          .sort((a, b) => a.canon.localeCompare(b.canon))
      )
    )

  /**
   * The canon decisions for a whole ingest, made once.
   *
   * Reconciling per session as the graph grows is *not* idempotent: on a first
   * pass session 1 only sees the entities of sessions before it, and on a
   * re-ingest it sees all of them, so a canon can merge on the second run that
   * did not merge on the first, and a re-run changes the slot count. Deciding
   * every canon up front from the same input makes a re-ingest a genuine no-op.
   */
  const reconcileAll = (
    knownEntities: ReadonlyArray<ExtractedEntity>,
    claims: ReadonlyArray<ExtractedClaim>
  ): Reconciled => reconcile(knownEntities, claims.flatMap((claim) => claim.entities))

  const writeSession = (
    uid: string,
    session: DatasetSession,
    claims: ReadonlyArray<ExtractedClaim>,
    reconciled: Reconciled
  ): Effect.Effect<SessionWrite, HydraError> =>
    Effect.gen(function* () {
      const { rename } = reconciled
      const canonOf = (canon: string): string => rename.get(canon) ?? canon

      // The reconciled list covers the whole ingest; this session only writes
      // the entities its own claims mention, so a 48-session haystack does not
      // rewrite all 2 200 entity vertices 48 times.
      const mentioned = new Set(
        claims.flatMap((claim) => claim.entities.map((entity) => canonOf(entity.canon)))
      )
      const entities = reconciled.entities.filter((entity) => mentioned.has(entity.canon))

      // ---- vertices -------------------------------------------------------

      yield* hydra.batchMerge(
        "Entity",
        entities.map((entity) => ({
          key: entityKey(uid, entity.canon),
          properties: {
            ekey: entityKey(uid, entity.canon),
            uid,
            name: entity.canon,
            etype: entity.etype,
            aliases: entity.aliases.join(ALIAS_SEPARATOR)
          }
        }))
      )

      const written: Array<WrittenClaim> = []
      const claimRows = claims.map((claim) => {
        const ckey = claimKey(uid, claimDigest(claim, session.key))
        const skey =
          claim.slot === null
            ? null
            : slotKey(uid, canonOf(claim.slot.entityCanon), claim.slot.attr)
        written.push({ ckey, skey, sessionOrd: session.sessionOrd })
        return { claim, ckey, skey }
      })

      yield* hydra.batchMerge(
        "Claim",
        claimRows.map(({ claim, ckey }) => ({
          key: ckey,
          properties: {
            ckey,
            // Constant per user: the MSpaths target selector. With a constant
            // target property every source→claim pair is returned, instead of
            // one path per source (the pathCount trap).
            kind: claimKind(uid),
            uid,
            text: claim.text,
            speaker: claim.speaker,
            ctype: claim.ctype,
            session_ord: session.sessionOrd,
            t_event: claim.tEvent,
            t_prec: claim.tPrec,
            sid: session.sid,
            turn_idx: claim.span.turnIdx,
            cs: claim.span.cs,
            ce: claim.span.ce,
            session_date: session.date.dateInt,
            located: claim.located
          } satisfies Record<string, Scalar>
        }))
      )

      const slots = new Map<string, { entityCanon: string; attr: string }>()
      for (const { claim, skey } of claimRows) {
        if (skey === null || claim.slot === null) continue
        slots.set(skey, { entityCanon: canonOf(claim.slot.entityCanon), attr: claim.slot.attr })
      }

      yield* hydra.batchMerge(
        "Slot",
        [...slots.entries()].map(([skey, slot]) => ({
          key: skey,
          properties: {
            skey,
            uid,
            entity_ekey: entityKey(uid, slot.entityCanon),
            entity_name: slot.entityCanon,
            attr: slot.attr
          }
        }))
      )

      // ---- tokens ---------------------------------------------------------

      const tokensByClaim = claimRows.map(({ claim, ckey }) => ({
        ckey,
        tokens: claimTokens({
          text: claim.text,
          keywords: claim.keywords,
          entityNames: claim.entities.flatMap((entity) => [canonOf(entity.canon), ...entity.aliases])
        })
      }))
      const entityTokens = entities.map((entity) => ({
        canon: entity.canon,
        tokens: [...new Set([entity.canon, ...entity.aliases].flatMap((name) => claimTokens({
          text: name,
          keywords: [],
          entityNames: []
        })))]
      }))

      const allTokens = new Set<string>()
      for (const { tokens } of tokensByClaim) for (const token of tokens) allTokens.add(token)
      for (const { tokens } of entityTokens) for (const token of tokens) allTokens.add(token)

      yield* hydra.batchMerge(
        "Token",
        [...allTokens].map((stem) => ({
          key: tokenKey(uid, stem),
          properties: { tkey: tokenKey(uid, stem), uid, stem, df: 0 }
        }))
      )

      // ---- edges ----------------------------------------------------------

      yield* hydra.batchRel(
        "EVIDENCE",
        claimRows.map(({ claim, ckey }) => ({
          srcLabel: "Claim",
          srcKey: ckey,
          dstLabel: "Turn",
          dstKey: turnKey(uid, session.key, claim.span.turnIdx),
          properties: { cs: claim.span.cs, ce: claim.span.ce }
        }))
      )

      yield* hydra.batchRel(
        "MENTIONS",
        [
          ...new Map(
            claimRows.flatMap(({ claim, ckey }) =>
              claim.entities.map((entity) => {
                const canon = canonOf(entity.canon)
                return [
                  `${canon} | ${ckey}`,
                  {
                    srcLabel: "Entity",
                    srcKey: entityKey(uid, canon),
                    dstLabel: "Claim",
                    dstKey: ckey
                  }
                ] as const
              })
            )
          ).values()
        ]
      )

      yield* hydra.batchRel(
        "FILLS",
        claimRows
          .filter(({ skey }) => skey !== null)
          .map(({ ckey, skey }) => ({
            srcLabel: "Claim",
            srcKey: ckey,
            dstLabel: "Slot",
            dstKey: skey!
          }))
      )

      yield* hydra.batchRel(
        "HITS",
        tokensByClaim.flatMap(({ ckey, tokens }) =>
          tokens.map((stem) => ({
            srcLabel: "Token",
            srcKey: tokenKey(uid, stem),
            dstLabel: "Claim",
            dstKey: ckey
          }))
        )
      )

      yield* hydra.batchRel(
        "NAMES",
        entityTokens.flatMap(({ canon, tokens }) =>
          tokens.map((stem) => ({
            srcLabel: "Token",
            srcKey: tokenKey(uid, stem),
            dstLabel: "Entity",
            dstKey: entityKey(uid, canon)
          }))
        )
      )

      // The user root, so `readEntities`, `contestedSlots` and `stats` never
      // have to scan a label. Same content-addressed MERGE as everything else.
      yield* linkToUser(hydra, uid, "HAS_ENTITY", "Entity", entities.map((entity) => entityKey(uid, entity.canon)))
      yield* linkToUser(hydra, uid, "HAS_SLOT", "Slot", [...slots.keys()])

      return {
        claims: written,
        entities,
        touchedSlots: [...slots.keys()],
        tokens: allTokens.size,
        tokenHits: tokensByClaim.flatMap(({ tokens }) => tokens),
        slotFills: claimRows.filter(({ skey }) => skey !== null).map(({ skey }) => skey!)
      }
    })

  /**
   * Writes the two derived counts an ingest produces: `Token.df` (how many
   * Claims each anchor hits, the input to idf at query time) and
   * `Slot.n_claims` (how many Claims contest each slot).
   *
   * Both are counted while writing rather than read back with an aggregate
   * join. `MATCH (t:Token)-[:HITS]->(c:Claim) … count(*)` blows the engine's
   * 30 s runtime cap once a handful of users share the graph — and it has to,
   * since it joins every token against every claim in the store. Counting
   * during the write is O(1) queries and, because a full ingest writes all of a
   * user's claims, gives the same answer.
   */
  const writeCounts = (
    uid: string,
    counts: {
      readonly tokenDf: ReadonlyMap<string, number>
      readonly slotClaims: ReadonlyMap<string, number>
      readonly slotEntities: ReadonlyMap<string, { readonly entityCanon: string; readonly attr: string }>
    }
  ): Effect.Effect<void, HydraError> =>
    Effect.gen(function* () {
      yield* hydra.batchMerge(
        "Token",
        [...counts.tokenDf].map(([stem, df]) => ({
          key: tokenKey(uid, stem),
          properties: { tkey: tokenKey(uid, stem), uid, stem, df }
        }))
      )
      yield* hydra.batchMerge(
        "Slot",
        [...counts.slotClaims].map(([skey, n]) => {
          const slot = counts.slotEntities.get(skey)
          return {
            key: skey,
            properties: {
              skey,
              uid,
              entity_ekey: entityKey(uid, slot?.entityCanon ?? ""),
              entity_name: slot?.entityCanon ?? "",
              attr: slot?.attr ?? "",
              n_claims: n
            }
          }
        })
      )
    })

  /**
   * The current `df` of the given tokens, in one round trip.
   *
   * A whole-user ingest counts `df` while writing and never reads it back. A
   * *single-session* ingest cannot: the session adds to counts the rest of the
   * history already contributed to, so it has to know what they are.
   *
   * There is no batched read by id on this engine, so this leans on the
   * `MSpaths` per-source path cap instead of fighting it: `pathCount: 1` asks
   * for one path per token, and the path's source node carries `df`. A token
   * with no `HITS` edge returns no path and is 0, which is exactly right.
   */
  const readTokenDf = (
    uid: string,
    stems: ReadonlyArray<string>
  ): Effect.Effect<ReadonlyMap<string, number>, HydraError> =>
    Effect.gen(function* () {
      const df = new Map<string, number>()
      if (stems.length === 0) return df
      const paths = yield* hydra.msPaths({
        sourceLabel: "Token",
        sourceProperty: "tkey",
        sourceValues: stems.map((stem) => tokenKey(uid, stem)),
        relTypes: ["HITS"],
        relDirection: "outgoing",
        maxLen: 1,
        pathCount: 1
      })
      for (const path of paths) {
        const token = path.nodes[0]
        if (token === undefined) continue
        const stem = String(token.properties["stem"] ?? "")
        if (stem !== "") df.set(stem, Number(token.properties["df"] ?? 0))
      }
      return df
    })

  /** The same trick for `Slot.n_claims`, read off the slot each path starts at. */
  const readSlotClaimCounts = (
    skeys: ReadonlyArray<string>
  ): Effect.Effect<ReadonlyMap<string, number>, HydraError> =>
    Effect.gen(function* () {
      const counts = new Map<string, number>()
      if (skeys.length === 0) return counts
      const paths = yield* hydra.msPaths({
        sourceLabel: "Slot",
        sourceProperty: "skey",
        sourceValues: [...skeys],
        relTypes: ["FILLS"],
        relDirection: "incoming",
        maxLen: 1,
        pathCount: 1
      })
      for (const path of paths) {
        const slot = path.nodes[0]
        if (slot === undefined) continue
        const skey = String(slot.properties["skey"] ?? "")
        if (skey !== "") counts.set(skey, Number(slot.properties["n_claims"] ?? 0))
      }
      return counts
    })

  /**
   * Just the claim count, off the `User` vertex in one ~100 ms read by id.
   *
   * Zero means "this user was never indexed" — either never ingested, or
   * ingested before the `User` vertex existed, which `pnpm backfill-user`
   * repairs.
   */
  const claimCount = (uid: string): Effect.Effect<number, HydraError> =>
    readUserStats(hydra, uid).pipe(
      Effect.map((stats) => (stats._tag === "Some" ? stats.value.claims : 0))
    )

  /**
   * Everything `stats` used to count, read off the `User` vertex.
   *
   * The old shape was six `MATCH (n:Label) WHERE n.uid = $uid RETURN count(*)`
   * scans plus two Slot scans, at the *end of every ingest*: 4.4 s for Claims
   * and 8.7 s for Tokens at 26 users, and past the 30 s cap at 100 — so a
   * fully written user would have been reported FAILED by the timeout of the
   * read that was only there to describe it. Every one of these numbers was
   * already known in memory when the ingest wrote them.
   */
  const stats = (uid: string): Effect.Effect<UserStats, HydraError> =>
    readUserStats(hydra, uid).pipe(
      Effect.map((stats) => (stats._tag === "Some" ? stats.value : EMPTY_STATS))
    )

  /**
   * Counts the supersession edges a user holds, by walking out of the claims of
   * its contested slots. Every supersession edge is inside a slot with ≥ 2
   * claims by construction, so the walk is exhaustive — and unlike
   * `MATCH (a:Claim)-[:SUPERSEDED_BY]->(b:Claim) WHERE a.uid = $uid`, which
   * measured **24.7 s**, it is driven from indexed source values.
   *
   * An ingest knows this number without asking; this exists for `backfill-user`,
   * which has to recover it from a graph written before the `User` vertex did.
   */
  const countSupersessions = (
    uid: string,
    contestedSkeys: ReadonlyArray<string>
  ): Effect.Effect<number, HydraError> =>
    Effect.gen(function* () {
      if (contestedSkeys.length === 0) return 0
      const slotClaims = yield* hydra.msPaths({
        sourceLabel: "Slot",
        sourceProperty: "skey",
        sourceValues: [...contestedSkeys],
        targetLabel: "Claim",
        targetProperty: "kind",
        targetValues: [claimKind(uid)],
        relTypes: ["FILLS"],
        relDirection: "incoming",
        maxLen: 1
      })
      const ckeys = [
        ...new Set(
          slotClaims
            .map((path) => String(path.nodes[path.nodes.length - 1]?.properties["ckey"] ?? ""))
            .filter((ckey) => ckey !== "")
        )
      ]
      if (ckeys.length === 0) return 0
      const paths = yield* hydra.msPaths({
        sourceLabel: "Claim",
        sourceProperty: "ckey",
        sourceValues: ckeys,
        targetLabel: "Claim",
        targetProperty: "kind",
        targetValues: [claimKind(uid)],
        relTypes: ["SUPERSEDED_BY"],
        relDirection: "outgoing",
        maxLen: 1
      })
      return paths.filter((path) => path.relationships.length === 1).length
    })

  /** Drops a user's claim graph (not their transcript). */
  const remove = (uid: string): Effect.Effect<void, HydraError> =>
    Effect.gen(function* () {
      const keys: Array<string> = []
      for (const [label, property] of [
        ["Claim", "ckey"],
        ["Entity", "ekey"],
        ["Slot", "skey"],
        ["Token", "tkey"]
      ] as const) {
        const result = yield* hydra.query(
          `MATCH (n:${label}) WHERE n.uid = $uid RETURN n.${property} AS key`,
          { uid }
        )
        keys.push(...result.rows.map((row) => String(row["key"])))
      }
      yield* hydra.deleteByKeys(keys)
    })

  return {
    readEntities,
    reconcileAll,
    writeSession,
    writeCounts,
    readTokenDf,
    readSlotClaimCounts,
    claimCount,
    countSupersessions,
    stats,
    remove
  } as const
})

export class ClaimGraph extends Effect.Service<ClaimGraph>()("palimpsest/ClaimGraph", {
  effect: make
}) {}
