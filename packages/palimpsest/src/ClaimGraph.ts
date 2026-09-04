import type { DatasetSession } from "@palimpsest/dataset"
import { HydraClient, type HydraError, type Scalar } from "@palimpsest/hydra"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import { reconcile, type Reconciled } from "./Canon.js"
import type { ExtractedClaim, ExtractedEntity } from "./Extract.js"
import { claimKey, claimKind, entityKey, slotKey, tokenKey, turnKey } from "./Keys.js"
import { claimTokens } from "./Tokenize.js"
import { canonicalSessionSource } from "./SourceIdentity.js"
import { EMPTY_STATS, linkToUser, readUserStats, readUserVertices, type UserStats } from "./User.js"

// HydraDB has no list type; aliases are one string joined by the ASCII unit separator.
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
  readonly touchedSlots: ReadonlyArray<string>
  readonly tokens: number
  readonly tokenHits: ReadonlyArray<string>
  readonly slotFills: ReadonlyArray<string>
}

export type { UserStats } from "./User.js"

const make = Effect.gen(function* () {
  const hydra = yield* HydraClient

  const readEntities = (uid: string): Effect.Effect<ReadonlyArray<ExtractedEntity>, HydraError> =>
    readUserVertices(hydra, uid, "HAS_ENTITY").pipe(
      Effect.map((rows) =>
        rows
          .map((row) => ({
            canon: String(row["name"] ?? ""),
            etype: String(row["etype"] ?? "topic") as ExtractedEntity["etype"],
            aliases: String(row["aliases"] ?? "")
              .split(ALIAS_SEPARATOR)
              .filter((alias) => alias !== "")
          }))
          .filter((entity) => entity.canon !== "")
          .sort((a, b) => a.canon.localeCompare(b.canon))
      )
    )

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
      const source = canonicalSessionSource(session)
      const { rename } = reconciled
      const canonOf = (canon: string): string => rename.get(canon) ?? canon

      const mentioned = new Set(
        claims.flatMap((claim) => claim.entities.map((entity) => canonOf(entity.canon)))
      )
      const entities = reconciled.entities.filter((entity) => mentioned.has(entity.canon))

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
            source_digest: source.sourceDigest,
            source_session_id: session.key,
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

  const claimCount = (uid: string): Effect.Effect<number, HydraError> =>
    readUserStats(hydra, uid).pipe(
      Effect.map((stats) => (stats._tag === "Some" ? stats.value.claims : 0))
    )

  const stats = (uid: string): Effect.Effect<UserStats, HydraError> =>
    readUserStats(hydra, uid).pipe(
      Effect.map((stats) => (stats._tag === "Some" ? stats.value : EMPTY_STATS))
    )

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
