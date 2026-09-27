import { createHash } from "node:crypto"
import { Data, Effect, Schema } from "effect"
import { Llm } from "@palimpsest/llm"
import { claimDigest } from "./ClaimGraph.js"
import { matchKeys } from "./Canon.js"
import type { ExtractedEntity } from "./Extract.js"
import type { ExtractionArtifact } from "./ExtractionArtifact.js"
import { indexEntityIdentityId } from "./IndexGraph.js"
import type { SourceRevision, SupersessionDecisionLink } from "./IngestManifest/Types.js"
import { canonicalJson, type CanonicalJson } from "./SourceIdentity.js"

/**
 * One claim inside a contested slot chain, addressed by the revision and digest
 * the snapshot graph uses, and carrying the fields the decider prompt needs.
 */
export interface SupersessionChainEntry {
  readonly commitId: string
  readonly claimDigest: string
  readonly text: string
  readonly speaker: string
  readonly sessionOrd: number
  readonly tEvent: number
  readonly turnIdx: number
  readonly cs: number
}

/** All claims known to fill one canonical entity's attribute, oldest first. */
export interface SupersessionChain {
  /** Content-addressed identity for independently durable provider work. */
  readonly id: string
  /** Lowest canon in the deterministic match-key group; display label only. */
  readonly entityCanon: string
  readonly attr: string
  readonly claims: ReadonlyArray<SupersessionChainEntry>
}

/** A provider-backed supersession decision could not be produced. Safe to retry. */
export class SupersessionDecisionUnavailable extends Data.TaggedError(
  "SupersessionDecisionUnavailable"
)<{
  readonly cause: unknown
}> {
  override get message(): string {
    return "Supersession decision provider is unavailable"
  }
}

/** 0-based indices into `SupersessionChain.claims`. */
export interface SupersessionIndexPair {
  readonly older: number
  readonly newer: number
}

export interface SupersessionChainSource {
  readonly revision: SourceRevision
  readonly artifact: ExtractionArtifact
}

class MatchGroups {
  private readonly parent = new Map<string, string>()

  add(identityId: string): void {
    if (!this.parent.has(identityId)) this.parent.set(identityId, identityId)
  }

  find(identityId: string): string {
    let root = this.parent.get(identityId) ?? identityId
    while (true) {
      const next = this.parent.get(root)
      if (next === undefined || next === root) break
      root = next
    }
    let current = identityId
    while (current !== root) {
      const next = this.parent.get(current) ?? current
      this.parent.set(current, root)
      current = next
    }
    return root
  }

  union(left: string, right: string): void {
    const rootLeft = this.find(left)
    const rootRight = this.find(right)
    if (rootLeft !== rootRight) {
      this.parent.set(rootLeft < rootRight ? rootRight : rootLeft, rootLeft < rootRight ? rootLeft : rootRight)
    }
  }
}

const slotEntity = (
  canon: string,
  entitiesByCanon: ReadonlyMap<string, ExtractedEntity>
): ExtractedEntity =>
  entitiesByCanon.get(canon) ?? { canon, etype: "topic", aliases: [] }

/**
 * Every extracted (or slot-implied) entity identity across the sources, keyed
 * by `indexEntityIdentityId`. Slot entities resolve against the same source's
 * canon map first — exactly the snapshot planner's collection rule, so the
 * identities a canonical view covers always match what the planner registers.
 */
export const collectEntityIdentities = (
  sources: ReadonlyArray<SupersessionChainSource>
): ReadonlyMap<string, ExtractedEntity> => {
  const identities = new Map<string, ExtractedEntity>()
  for (const { artifact } of sources) {
    const canons = new Map<string, ExtractedEntity>()
    for (const claim of artifact.extraction.claims) {
      for (const entity of claim.entities) {
        if (!canons.has(entity.canon)) canons.set(entity.canon, entity)
      }
    }
    for (const claim of artifact.extraction.claims) {
      for (const entity of claim.entities) {
        identities.set(indexEntityIdentityId(entity), entity)
      }
      if (claim.slot !== null) {
        const entity = slotEntity(claim.slot.entityCanon, canons)
        identities.set(indexEntityIdentityId(entity), entity)
      }
    }
  }
  return identities
}

/**
 * Deterministic equivalence edges between identities that share a match key —
 * each key's members are star-linked to its lowest identity id. Consolidation
 * feeds these to `createEntityCanonicalView`; enrichment uses the same union
 * when grouping slot chains, so both agree on the same canonical partition.
 */
export const matchKeyEquivalences = (
  identities: ReadonlyMap<string, ExtractedEntity>
): ReadonlyArray<{ readonly leftIdentityId: string; readonly rightIdentityId: string }> => {
  const firstWithKey = new Map<string, string>()
  const edges = new Map<string, { leftIdentityId: string; rightIdentityId: string }>()
  for (const identityId of [...identities.keys()].sort()) {
    const entity = identities.get(identityId)
    if (entity === undefined) continue
    for (const key of matchKeys(entity)) {
      const first = firstWithKey.get(key)
      if (first === undefined) {
        firstWithKey.set(key, identityId)
      } else if (first !== identityId) {
        const [left, right] = first < identityId ? [first, identityId] : [identityId, first]
        edges.set(`${left}|${right}`, { leftIdentityId: left, rightIdentityId: right })
      }
    }
  }
  return [...edges.values()].sort((left, right) =>
    left.leftIdentityId === right.leftIdentityId
      ? left.rightIdentityId.localeCompare(right.rightIdentityId)
      : left.leftIdentityId.localeCompare(right.leftIdentityId)
  )
}

/**
 * Build contested slot chains across the given revisions' artifacts. Entities
 * are grouped by the same deterministic match-key union consolidation uses for
 * canonical views, so a chain sees claims across extracted-canon spellings.
 * Only chains containing at least one claim from `targetCommitId` are returned;
 * a revision's enrichment owns decisions for the claims it introduced.
 */
export const collectSupersessionChains = (
  sources: ReadonlyArray<SupersessionChainSource>,
  targetCommitId: string
): ReadonlyArray<SupersessionChain> => {
  const identities = collectEntityIdentities(sources)
  const canonsBySource = sources.map(({ artifact }) => {
    const canons = new Map<string, ExtractedEntity>()
    for (const claim of artifact.extraction.claims) {
      for (const entity of claim.entities) {
        if (!canons.has(entity.canon)) canons.set(entity.canon, entity)
      }
    }
    return canons
  })

  const groups = new MatchGroups()
  for (const edge of matchKeyEquivalences(identities)) {
    groups.add(edge.leftIdentityId)
    groups.add(edge.rightIdentityId)
    groups.union(edge.leftIdentityId, edge.rightIdentityId)
  }
  for (const identityId of identities.keys()) groups.add(identityId)

  const chains = new Map<string, { entityCanon: string; attr: string; claims: Array<SupersessionChainEntry> }>()
  for (const [index, { revision, artifact }] of sources.entries()) {
    const canons = canonsBySource[index]
    if (canons === undefined) continue
    for (const claim of artifact.extraction.claims) {
      if (claim.slot === null) continue
      const entity = slotEntity(claim.slot.entityCanon, canons)
      const root = groups.find(indexEntityIdentityId(entity))
      const key = `${root}|${claim.slot.attr}`
      const chain = chains.get(key) ?? { entityCanon: entity.canon, attr: claim.slot.attr, claims: [] }
      chain.claims.push({
        commitId: revision.commitId,
        claimDigest: claimDigest(claim, revision.logicalSessionId),
        text: claim.text,
        speaker: claim.speaker,
        sessionOrd: revision.sessionOrdinal,
        tEvent: claim.tEvent,
        turnIdx: claim.span.turnIdx,
        cs: claim.span.cs
      })
      chains.set(key, chain)
    }
  }

  return [...chains.entries()]
    .map(([key, chain]) => ({ key, chain }))
    .sort((left, right) => left.key.localeCompare(right.key))
    .map(({ chain }) => {
      const claims = chain.claims.sort(
        (left, right) =>
          left.sessionOrd - right.sessionOrd ||
          left.turnIdx - right.turnIdx ||
          left.cs - right.cs ||
          left.claimDigest.localeCompare(right.claimDigest)
      )
      const identity: CanonicalJson = {
        attr: chain.attr,
        claims: claims.map(
          (claim): CanonicalJson => ({
            claim_digest: claim.claimDigest,
            commit_id: claim.commitId,
            cs: claim.cs,
            session_ord: claim.sessionOrd,
            speaker: claim.speaker,
            t_event: claim.tEvent,
            text: claim.text,
            turn_idx: claim.turnIdx
          })
        ),
        entity_canon: chain.entityCanon,
        format: "palimpsest.supersession-chain.v1"
      }
      return {
        id: `supersession-chain-v1-${createHash("sha256").update(canonicalJson(identity), "utf8").digest("hex")}`,
        entityCanon: chain.entityCanon,
        attr: chain.attr,
        claims
      }
    })
    .filter(
      (chain) =>
        chain.claims.length >= 2 && chain.claims.some((claim) => claim.commitId === targetCommitId)
    )
}

/** Resolve decided index pairs into durable claim references; out-of-range, self, or backward pairs are dropped. */
export const pairsToDecisionLinks = (
  chain: SupersessionChain,
  pairs: ReadonlyArray<SupersessionIndexPair>
): ReadonlyArray<SupersessionDecisionLink> => {
  const seen = new Set<string>()
  const links: Array<SupersessionDecisionLink> = []
  for (const pair of pairs) {
    const older = chain.claims[pair.older]
    const newer = chain.claims[pair.newer]
    if (older === undefined || newer === undefined) continue
    if (pair.newer <= pair.older) continue
    const link: SupersessionDecisionLink = {
      older: { commitId: older.commitId, claimDigest: older.claimDigest },
      newer: { commitId: newer.commitId, claimDigest: newer.claimDigest }
    }
    const key = `${link.older.commitId}|${link.older.claimDigest}|${link.newer.commitId}|${link.newer.claimDigest}`
    if (seen.has(key)) continue
    seen.add(key)
    links.push(link)
  }
  return links
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

const renderPrompt = (chain: SupersessionChain): string =>
  [
    `SLOT: ${chain.entityCanon} | ${chain.attr}`,
    "",
    "CLAIMS, oldest first:",
    ...chain.claims.map((claim, index) => {
      const date = claim.tEvent > 0 ? `, event ${claim.tEvent}` : ""
      return `${index + 1}. (session ${claim.sessionOrd}${date}) ${claim.text}`
    })
  ].join("\n")

/**
 * Production decider for contested slot chains (S04). Mirrors the legacy
 * `Supersede.detect` prompt but resolves claims by manifest identity instead of
 * mutable user-graph ckeys. Callers receive 0-based chain indices.
 */
export const decideSlotSupersession = (
  chain: SupersessionChain
): Effect.Effect<ReadonlyArray<SupersessionIndexPair>, SupersessionDecisionUnavailable, Llm> =>
  Effect.gen(function* () {
    if (chain.claims.length < 2) return []
    const llm = yield* Llm
    const generated = yield* llm
      .generateObject({
        kind: "supersede",
        system: SYSTEM,
        prompt: renderPrompt(chain),
        schema: Replacements,
        objectName: "replacements"
      })
      .pipe(Effect.mapError((cause) => new SupersessionDecisionUnavailable({ cause })))
    const pairs: Array<SupersessionIndexPair> = []
    for (const pair of generated.value.replacements) {
      const older = pair.older - 1
      const newer = pair.newer - 1
      if (older < 0 || newer >= chain.claims.length || newer <= older) continue
      pairs.push({ older, newer })
    }
    return pairs
  })
