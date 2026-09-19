import { HydraClient, type HydraError, type HydraPath } from "@palimpsest/hydra"
import { Llm } from "@palimpsest/llm"
import { Context, Effect, Layer, Schema } from "effect"
import { claimKind } from "./Keys.js"
import { readUserVertices } from "./User.js"

export interface SlotClaim {
  readonly ckey: string
  readonly text: string
  readonly sessionOrd: number
  readonly tEvent: number
  readonly sid: string
}

/** A derived slot assertion with the source-revision witness needed for display. */
export interface SourceLinkedSlotClaim extends SlotClaim {
  readonly speaker: string
  readonly ctype: string
  readonly sessionDate: number
  readonly tPrec: string
  readonly turnIdx: number
  readonly cs: number
  readonly ce: number
  readonly sourceDigest: string
  readonly sourceLogicalSessionId: string
}

export interface SupersessionEdge {
  readonly olderCkey: string
  readonly newerCkey: string
  /** The session at which the replacement became true — the newer claim's ord. */
  readonly atSession: number
}

/** A claim in a slot's chain, labelled with what (if anything) replaced it. */
export type ChainClaim = SourceLinkedSlotClaim & {
  readonly supersededBy: string | null
  readonly atSession: number | null
}

export interface SupersedeReport {
  readonly slotsExamined: number
  readonly slotsContested: number
  readonly edges: number
  readonly cachedDecisions: number
}

const Replacements = Schema.Struct({
  replacements: Schema.Array(
    Schema.Struct({
      older: Schema.Number,
      newer: Schema.Number,
      reason: Schema.String
    })
  )
})

const SYSTEM = `You decide which claims REPLACE which, inside a single slot of a memory graph.

A slot is one (entity, attribute) pair — "me | residence", "hamster | name", "car | mileage". You
are given every claim that has filled this slot, in chronological order, numbered from 1, with the
session number and any resolved event date.

Return the pairs where a later claim makes an earlier claim's value NO LONGER TRUE. That is the only
relation you are looking for: replacement.

Return a pair when:
- the value changed — moved from Brooklyn to San Francisco, renamed the hamster, changed jobs,
  rescheduled a deadline, corrected a number
- a plan was superseded by a different plan for the same thing
- a later statement explicitly corrects or retracts an earlier one

Do NOT return a pair when:
- both claims are still true — two hobbies, two items on a list, two friends, two symptoms
- the later claim adds detail to the earlier one without contradicting it
- the later claim is about a different instance, occasion or time period, and both remain facts
- the claims merely repeat each other

Link each superseded claim to the claim that replaced it — the *next* value, not the final one, so a
three-step history produces two pairs (1->2, 2->3) rather than 1->3 and 2->3.

Give a short reason for each pair. When in doubt, return no pair: a wrong link hides a fact that is
still true, while a missing link only leaves an extra claim in the evidence.`

const renderPrompt = (
  entityName: string,
  attr: string,
  claims: ReadonlyArray<SlotClaim>
): string =>
  [
    `SLOT: ${entityName} | ${attr}`,
    "",
    "CLAIMS, oldest first:",
    ...claims.map((claim, index) => {
      const date = claim.tEvent > 0 ? `, event ${claim.tEvent}` : ""
      return `${index + 1}. (session ${claim.sessionOrd}${date}) ${claim.text}`
    })
  ].join("\n")

export const foldSupersessionEdges = (
  paths: ReadonlyArray<HydraPath>,
  asOf?: number
): ReadonlyMap<string, { readonly newer: string; readonly atSession: number }> => {
  const byOlder = new Map<string, { newer: string; atSession: number }>()
  for (const path of paths) {
    const older = path.nodes[0]
    const newer = path.nodes[path.nodes.length - 1]
    const edge = path.relationships[0]
    if (older === undefined || newer === undefined || edge === undefined) continue
    const atSession = Number(edge.properties["at_session"] ?? 0)
    if (asOf !== undefined && atSession > asOf) continue
    const olderCkey = String(older.properties["ckey"] ?? "")
    const newerCkey = String(newer.properties["ckey"] ?? "")
    if (olderCkey === "" || newerCkey === "") continue
    const existing = byOlder.get(olderCkey)
    if (
      existing !== undefined &&
      (existing.atSession < atSession ||
        (existing.atSession === atSession && existing.newer <= newerCkey))
    ) {
      continue
    }
    byOlder.set(olderCkey, { newer: newerCkey, atSession })
  }
  return byOlder
}

const make = Effect.gen(function* () {
  const hydra = yield* HydraClient
  const llm = yield* Llm

  const readSlotClaims = (
    uid: string,
    skeys: ReadonlyArray<string>
  ): Effect.Effect<ReadonlyMap<string, ReadonlyArray<SourceLinkedSlotClaim>>, HydraError> =>
    Effect.gen(function* () {
      const bySlot = new Map<string, Array<SourceLinkedSlotClaim>>()
      if (skeys.length === 0) return bySlot

      const paths = yield* hydra.msPaths({
        sourceLabel: "Slot",
        sourceProperty: "skey",
        sourceValues: skeys,
        targetLabel: "Claim",
        targetProperty: "kind",
        targetValues: [claimKind(uid)],
        relTypes: ["FILLS"],
        relDirection: "incoming",
        maxLen: 1
      })

      for (const path of paths) {
        const slot = path.nodes[0]
        const claim = path.nodes[path.nodes.length - 1]
        if (slot === undefined || claim === undefined || slot === claim) continue
        const skey = String(slot.properties["skey"] ?? "")
        const bucket = bySlot.get(skey) ?? []
        bucket.push({
          ckey: String(claim.properties["ckey"] ?? ""),
          text: String(claim.properties["text"] ?? ""),
          sessionOrd: Number(claim.properties["session_ord"] ?? 0),
          tEvent: Number(claim.properties["t_event"] ?? 0),
          sid: String(claim.properties["sid"] ?? ""),
          speaker: String(claim.properties["speaker"] ?? ""),
          ctype: String(claim.properties["ctype"] ?? ""),
          sessionDate: Number(claim.properties["session_date"] ?? 0),
          tPrec: String(claim.properties["t_prec"] ?? ""),
          turnIdx: Number(claim.properties["turn_idx"] ?? 0),
          cs: Number(claim.properties["cs"] ?? 0),
          ce: Number(claim.properties["ce"] ?? 0),
          sourceDigest: String(claim.properties["source_digest"] ?? ""),
          sourceLogicalSessionId: String(claim.properties["source_session_id"] ?? "")
        })
        bySlot.set(skey, bucket)
      }

      for (const [skey, claims] of bySlot) {
        bySlot.set(
          skey,
          claims.sort(
            (a, b) =>
              a.sessionOrd - b.sessionOrd ||
              a.tEvent - b.tEvent ||
              a.ckey.localeCompare(b.ckey)
          )
        )
      }
      return bySlot
    })

  const detect = (
    entityName: string,
    attr: string,
    claims: ReadonlyArray<SlotClaim>
  ): Effect.Effect<
    { readonly edges: ReadonlyArray<SupersessionEdge>; readonly cached: boolean },
    never,
    Llm
  > =>
    Effect.gen(function* () {
      if (claims.length < 2) return { edges: [], cached: true }

      const generated = yield* llm
        .generateObject({
          kind: "supersede",
          system: SYSTEM,
          prompt: renderPrompt(entityName, attr, claims),
          schema: Replacements,
          objectName: "replacements"
        })
        .pipe(Effect.orDie)

      const edges: Array<SupersessionEdge> = []
      const seen = new Set<string>()
      for (const pair of generated.value.replacements) {
        const older = claims[pair.older - 1]
        const newer = claims[pair.newer - 1]
        if (older === undefined || newer === undefined) continue
        if (older.ckey === newer.ckey) continue
        if (newer.sessionOrd < older.sessionOrd) continue
        const id = `${older.ckey}->${newer.ckey}`
        if (seen.has(id)) continue
        seen.add(id)
        edges.push({
          olderCkey: older.ckey,
          newerCkey: newer.ckey,
          atSession: newer.sessionOrd
        })
      }
      return { edges, cached: generated.cached }
    })

  const run = (
    uid: string,
    slots: ReadonlyArray<{ readonly skey: string; readonly entityName: string; readonly attr: string }>
  ): Effect.Effect<SupersedeReport, HydraError, Llm> =>
    Effect.gen(function* () {
      const bySlot = yield* readSlotClaims(uid, slots.map((slot) => slot.skey))
      const contested = slots.filter((slot) => (bySlot.get(slot.skey)?.length ?? 0) >= 2)

      const results = yield* Effect.forEach(
        contested,
        (slot) => detect(slot.entityName, slot.attr, bySlot.get(slot.skey) ?? []),
        { concurrency: "unbounded" }
      )

      const edges = results.flatMap((result) => result.edges)
      yield* hydra.batchRel(
        "SUPERSEDED_BY",
        edges.map((edge) => ({
          srcLabel: "Claim",
          srcKey: edge.olderCkey,
          dstLabel: "Claim",
          dstKey: edge.newerCkey,
          properties: { at_session: edge.atSession }
        }))
      )

      return {
        slotsExamined: slots.length,
        slotsContested: contested.length,
        edges: edges.length,
        cachedDecisions: results.filter((result) => result.cached).length
      }
    })

  const contestedSlots = (
    uid: string
  ): Effect.Effect<
    ReadonlyArray<{
      readonly skey: string
      readonly entityName: string
      readonly attr: string
      readonly nClaims: number
    }>,
    HydraError
  > =>
    readUserVertices(hydra, uid, "HAS_SLOT").pipe(
      Effect.map((rows) =>
        rows
          .map((row) => ({
            skey: String(row["skey"] ?? ""),
            entityName: String(row["entity_name"] ?? ""),
            attr: String(row["attr"] ?? ""),
            nClaims: Number(row["n_claims"] ?? 0)
          }))
          .filter((slot) => slot.skey !== "" && slot.nClaims >= 2)
          .sort((a, b) => a.skey.localeCompare(b.skey))
      )
    )

  const readEdges = (
    uid: string,
    ckeys: ReadonlyArray<string>,
    asOf?: number
  ): Effect.Effect<ReadonlyMap<string, { readonly newer: string; readonly atSession: number }>, HydraError> =>
    Effect.gen(function* () {
      if (ckeys.length === 0) {
        return new Map<string, { readonly newer: string; readonly atSession: number }>()
      }

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

      return foldSupersessionEdges(paths, asOf)
    })

  const chains = (
    uid: string,
    skeys: ReadonlyArray<string>,
    asOf?: number
  ): Effect.Effect<ReadonlyMap<string, ReadonlyArray<ChainClaim>>, HydraError> =>
    Effect.gen(function* () {
      const bySlot = yield* readSlotClaims(uid, skeys)
      const visible = new Map<string, ReadonlyArray<SourceLinkedSlotClaim>>()
      for (const [skey, claims] of bySlot) {
        visible.set(
          skey,
          claims.filter((claim) => asOf === undefined || claim.sessionOrd <= asOf)
        )
      }

      const byOlder = yield* readEdges(
        uid,
        [...visible.values()].flat().map((claim) => claim.ckey),
        asOf
      )

      const out = new Map<string, ReadonlyArray<ChainClaim>>()
      for (const [skey, claims] of visible) {
        out.set(
          skey,
          claims.map((claim) => {
            const edge = byOlder.get(claim.ckey)
            return {
              ...claim,
              supersededBy: edge?.newer ?? null,
              atSession: edge?.atSession ?? null
            }
          })
        )
      }
      return out
    })

  const chain = (
    uid: string,
    skey: string,
    asOf?: number
  ): Effect.Effect<ReadonlyArray<ChainClaim>, HydraError> =>
    chains(uid, [skey], asOf).pipe(Effect.map((all) => all.get(skey) ?? []))

  return { readSlotClaims, readEdges, detect, run, contestedSlots, chain, chains } as const
})

export type Supersede = Effect.Success<typeof make>
const SupersedeTag = Context.Service<Supersede>("palimpsest/Supersede")
export const Supersede = Object.assign(SupersedeTag, { layer: Layer.effect(SupersedeTag, make) })
