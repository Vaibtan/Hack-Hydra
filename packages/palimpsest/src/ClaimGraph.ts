import type { DatasetSession } from "@palimpsest/dataset"
import { HydraClient, type HydraError, type Scalar } from "@palimpsest/hydra"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import { reconcile, type Reconciled } from "./Canon.js"
import type { ExtractedClaim, ExtractedEntity } from "./Extract.js"
import { claimKey, claimKind, entityKey, slotKey, tokenKey, turnKey } from "./Keys.js"
import { claimTokens } from "./Tokenize.js"

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

export interface UserStats {
  readonly claims: number
  readonly entities: number
  readonly slots: number
  readonly tokens: number
  readonly sessions: number
  readonly turns: number
  readonly supersessions: number
  /** Slots holding ≥ 2 claims — the health metric for whether supersession can fire. */
  readonly contestedSlots: number
}

const make = Effect.gen(function* () {
  const hydra = yield* HydraClient

  /** The user's entities, as the graph currently holds them. */
  const readEntities = (uid: string): Effect.Effect<ReadonlyArray<ExtractedEntity>, HydraError> =>
    Effect.gen(function* () {
      const result = yield* hydra.query(
        "MATCH (e:Entity) WHERE e.uid = $uid RETURN e.name AS name, e.etype AS etype, e.aliases AS aliases ORDER BY name",
        { uid }
      )
      return result.rows.map((row) => ({
        canon: String(row["name"]),
        etype: String(row["etype"]) as ExtractedEntity["etype"],
        // HydraDB has no list type, so aliases travel as a delimited string.
        aliases: String(row["aliases"] ?? "")
          .split(ALIAS_SEPARATOR)
          .filter((alias) => alias !== "")
      }))
    })

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
        const ckey = claimKey(uid, claimDigest(claim, session.sid))
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
          dstKey: turnKey(uid, session.sid, claim.span.turnIdx),
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

  const stats = (uid: string): Effect.Effect<UserStats, HydraError> =>
    Effect.gen(function* () {
      const count = (label: string) =>
        hydra
          .query(`MATCH (n:${label}) WHERE n.uid = $uid RETURN count(*) AS c`, { uid })
          .pipe(Effect.map((r) => Number(r.rows[0]?.["c"] ?? 0)))

      const claims = yield* count("Claim")
      const entities = yield* count("Entity")
      const slots = yield* count("Slot")
      const tokens = yield* count("Token")
      const sessions = yield* count("Session")
      const turns = yield* count("Turn")

      const superseded = yield* hydra.query(
        "MATCH (a:Claim)-[r:SUPERSEDED_BY]->(b:Claim) WHERE a.uid = $uid RETURN count(*) AS c",
        { uid }
      )
      // `n_claims` is denormalised onto the Slot at write time; the equivalent
      // `MATCH (c:Claim)-[:FILLS]->(s:Slot) … count(*)` join exceeds the
      // engine's 30 s cap once several users share the graph.
      const contested = yield* hydra.query(
        "MATCH (s:Slot) WHERE s.uid = $uid AND s.n_claims >= 2 RETURN count(*) AS c",
        { uid }
      )

      return {
        claims,
        entities,
        slots,
        tokens,
        sessions,
        turns,
        supersessions: Number(superseded.rows[0]?.["c"] ?? 0),
        contestedSlots: Number(contested.rows[0]?.["c"] ?? 0)
      }
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

  return { readEntities, reconcileAll, writeSession, writeCounts, stats, remove } as const
})

export class ClaimGraph extends Effect.Service<ClaimGraph>()("palimpsest/ClaimGraph", {
  effect: make
}) {}
