import type { DatasetSession } from "@palimpsest/dataset"
import { HydraClient, type HydraError, type Scalar } from "@palimpsest/hydra"
import { createHash } from "node:crypto"
import { Data, Effect, Either } from "effect"
import { claimDigest } from "./ClaimGraph.js"
import type { EntityIdentity } from "./EntityCanonicalView.js"
import type { ExtractedClaim, ExtractedEntity } from "./Extract.js"
import type { IndexGeneration } from "./IndexGeneration.js"
import type { SourceRevision } from "./IngestManifest.js"
import { canonicalJson, canonicalSessionSource } from "./SourceIdentity.js"
import { sourceSessionKey, sourceTurnKey } from "./SourceTranscript.js"
import { claimTokens } from "./Tokenize.js"

const ALIAS_SEPARATOR = "\u001f"

/** Stable semantic identity for an observed Entity; it never names a mutable graph record. */
export const indexEntityIdentityId = (entity: ExtractedEntity): string => {
  const aliases = [...new Set(entity.aliases)].sort((left, right) => left.localeCompare(right))
  const descriptor = canonicalJson({
    aliases,
    canon: entity.canon,
    etype: entity.etype,
    format: "palimpsest.entity-identity.v1"
  })
  return `entity-v1-${createHash("sha256").update(descriptor, "utf8").digest("hex")}`
}

/** Immutable vertex key for one source-bound entity record in one index generation. */
export const indexEntityKey = (
  uid: string,
  generationId: string,
  logicalSessionId: string,
  sourceDigest: string,
  identityId: string
): string =>
  `${sourceSessionKey(uid, logicalSessionId, sourceDigest)}|index|${generationId}|entity|${identityId}`

/** Immutable vertex key for one source-bound claim record in one index generation. */
export const indexClaimKey = (
  uid: string,
  generationId: string,
  logicalSessionId: string,
  sourceDigest: string,
  digest: string
): string =>
  `${sourceSessionKey(uid, logicalSessionId, sourceDigest)}|index|${generationId}|claim|${digest}`

/** Immutable vertex key for one source-bound slot record in one index generation. */
export const indexSlotKey = (
  uid: string,
  generationId: string,
  logicalSessionId: string,
  sourceDigest: string,
  identityId: string,
  attr: string
): string =>
  `${sourceSessionKey(uid, logicalSessionId, sourceDigest)}|index|${generationId}|slot|${identityId}|${attr}`

/** Immutable vertex key for one source-bound token record in one index generation. */
export const indexTokenKey = (
  uid: string,
  generationId: string,
  logicalSessionId: string,
  sourceDigest: string,
  stem: string
): string =>
  `${sourceSessionKey(uid, logicalSessionId, sourceDigest)}|index|${generationId}|token|${stem}`

/** A derived graph write could not prove its source lineage. */
export class IndexGraphWriteRejected extends Data.TaggedError("IndexGraphWriteRejected")<{
  readonly reason: "sourceRevisionMismatch" | "unknownTurn" | "invalidSpan"
}> {
  override get message(): string {
    return `Cannot build index graph record: ${this.reason}`
  }
}

/** One immutable index vertex prepared before the graph is touched. */
export interface IndexGraphVertex {
  readonly key: string
  readonly properties: Readonly<Record<string, Scalar>>
}

/** One index edge, including the source/index generation filters required by a reader. */
export interface IndexGraphRelation {
  readonly type: "INDEX_EVIDENCE" | "INDEX_MENTIONS" | "INDEX_FILLS" | "INDEX_HITS" | "INDEX_NAMES"
  readonly srcLabel: "IndexClaim" | "IndexEntity" | "IndexToken"
  readonly srcKey: string
  readonly dstLabel: "IndexClaim" | "IndexEntity" | "IndexSlot" | "SourceTurn"
  readonly dstKey: string
  readonly properties: Readonly<Record<string, Scalar>>
}

/** Complete isolated data-plane write for one source revision and index generation. */
export interface IndexGraphWritePlan {
  readonly generationId: string
  readonly sourceDigest: string
  readonly entityIdentities: ReadonlyArray<EntityIdentity>
  readonly entities: ReadonlyArray<IndexGraphVertex>
  readonly claims: ReadonlyArray<IndexGraphVertex>
  readonly slots: ReadonlyArray<IndexGraphVertex>
  readonly tokens: ReadonlyArray<IndexGraphVertex>
  readonly relations: ReadonlyArray<IndexGraphRelation>
}

/** Summary of the derived records written for one isolated source/index pair. */
export interface IndexGraphWriteReport {
  readonly generationId: string
  readonly sourceDigest: string
  readonly entities: number
  readonly claims: number
  readonly slots: number
  readonly tokens: number
}

/** Public input to the generation-scoped index writer. */
export interface PlanIndexGraphWrite {
  readonly generation: IndexGeneration
  readonly revision: SourceRevision
  readonly session: DatasetSession
  readonly claims: ReadonlyArray<ExtractedClaim>
}

const sourceProperties = (
  generation: IndexGeneration,
  revision: SourceRevision,
  sourceSession: string
): Readonly<Record<string, Scalar>> => ({
  index_generation: generation.id,
  source_digest: revision.sourceDigest,
  source_session: sourceSession,
  tenant: revision.tenant,
  uid: revision.uid
})

const entityForSlot = (
  entitiesByCanon: ReadonlyMap<string, ExtractedEntity>,
  canon: string
): ExtractedEntity => entitiesByCanon.get(canon) ?? { canon, etype: "topic", aliases: [] }

/**
 * Builds a generation- and source-scoped graph write without consulting mutable
 * graph state. Canonicalisation happens through the selected `SAME_AS` view,
 * not by renaming these immutable records in place.
 */
export const planIndexGraphWrite = (
  input: PlanIndexGraphWrite
): Either.Either<IndexGraphWritePlan, IndexGraphWriteRejected> => {
  const { generation, revision, session, claims } = input
  const canonical = canonicalSessionSource(session)
  if (
    session.key !== revision.logicalSessionId ||
    canonical.sourceDigest !== revision.sourceDigest ||
    canonical.sourceBytes !== revision.sourceBytes
  ) {
    return Either.left(new IndexGraphWriteRejected({ reason: "sourceRevisionMismatch" }))
  }

  const turns = new Map(session.turns.map((turn) => [turn.turnIdx, turn]))
  for (const claim of claims) {
    const turn = turns.get(claim.span.turnIdx)
    if (turn === undefined) return Either.left(new IndexGraphWriteRejected({ reason: "unknownTurn" }))
    if (
      !Number.isSafeInteger(claim.span.cs) ||
      !Number.isSafeInteger(claim.span.ce) ||
      claim.span.cs < 0 ||
      claim.span.ce <= claim.span.cs ||
      claim.span.ce > turn.text.length
    ) {
      return Either.left(new IndexGraphWriteRejected({ reason: "invalidSpan" }))
    }
  }

  const sourceSession = sourceSessionKey(revision.uid, revision.logicalSessionId, revision.sourceDigest)
  const source = sourceProperties(generation, revision, sourceSession)
  const entitiesByIdentity = new Map<string, ExtractedEntity>()
  const entitiesByCanon = new Map<string, ExtractedEntity>()
  for (const entity of claims.flatMap((claim) => claim.entities)) {
    const identityId = indexEntityIdentityId(entity)
    entitiesByIdentity.set(identityId, entity)
    if (!entitiesByCanon.has(entity.canon)) entitiesByCanon.set(entity.canon, entity)
  }
  for (const claim of claims) {
    if (claim.slot === null) continue
    const entity = entityForSlot(entitiesByCanon, claim.slot.entityCanon)
    entitiesByIdentity.set(indexEntityIdentityId(entity), entity)
    if (!entitiesByCanon.has(entity.canon)) entitiesByCanon.set(entity.canon, entity)
  }

  const entityIdentities = [...entitiesByIdentity.entries()]
    .map(([id, entity]) => ({ id, canon: entity.canon, etype: entity.etype }))
    .sort((left, right) => left.id.localeCompare(right.id))
  const entityKeyByIdentity = new Map<string, string>()
  const entities = entityIdentities.map((identity) => {
    const entity = entitiesByIdentity.get(identity.id)
    if (entity === undefined) throw new Error("entity identity was not readable")
    const key = indexEntityKey(
      revision.uid,
      generation.id,
      revision.logicalSessionId,
      revision.sourceDigest,
      identity.id
    )
    entityKeyByIdentity.set(identity.id, key)
    return {
      key,
      properties: {
        ...source,
        index_entity: key,
        entity_identity_id: identity.id,
        canon: entity.canon,
        etype: entity.etype,
        aliases: [...new Set(entity.aliases)].sort((left, right) => left.localeCompare(right)).join(ALIAS_SEPARATOR)
      }
    }
  })

  const relations: Array<IndexGraphRelation> = []
  const slotsByKey = new Map<string, IndexGraphVertex>()
  const tokensByKey = new Map<string, IndexGraphVertex>()
  const claimsOut: Array<IndexGraphVertex> = []
  for (const claim of claims) {
    const digest = claimDigest(claim, revision.logicalSessionId)
    const key = indexClaimKey(
      revision.uid,
      generation.id,
      revision.logicalSessionId,
      revision.sourceDigest,
      digest
    )
    claimsOut.push({
      key,
      properties: {
        ...source,
        index_claim: key,
        claim_digest: digest,
        text: claim.text,
        speaker: claim.speaker,
        ctype: claim.ctype,
        session_ord: revision.sessionOrdinal,
        t_event: claim.tEvent,
        t_prec: claim.tPrec,
        sid: session.sid,
        turn_idx: claim.span.turnIdx,
        cs: claim.span.cs,
        ce: claim.span.ce,
        session_date: session.date.dateInt,
        located: claim.located
      }
    })
    relations.push({
      type: "INDEX_EVIDENCE",
      srcLabel: "IndexClaim",
      srcKey: key,
      dstLabel: "SourceTurn",
      dstKey: sourceTurnKey(
        revision.uid,
        revision.logicalSessionId,
        revision.sourceDigest,
        claim.span.turnIdx
      ),
      properties: { ...source, cs: claim.span.cs, ce: claim.span.ce }
    })

    for (const entity of claim.entities) {
      const identityId = indexEntityIdentityId(entity)
      const entityKey = entityKeyByIdentity.get(identityId)
      if (entityKey === undefined) throw new Error("claim entity was not prepared")
      relations.push({
        type: "INDEX_MENTIONS",
        srcLabel: "IndexEntity",
        srcKey: entityKey,
        dstLabel: "IndexClaim",
        dstKey: key,
        properties: source
      })
    }

    if (claim.slot !== null) {
      const entity = entityForSlot(entitiesByCanon, claim.slot.entityCanon)
      const identityId = indexEntityIdentityId(entity)
      const entityKey = entityKeyByIdentity.get(identityId)
      if (entityKey === undefined) throw new Error("slot entity was not prepared")
      const slotKey = indexSlotKey(
        revision.uid,
        generation.id,
        revision.logicalSessionId,
        revision.sourceDigest,
        identityId,
        claim.slot.attr
      )
      slotsByKey.set(slotKey, {
        key: slotKey,
        properties: {
          ...source,
          index_slot: slotKey,
          entity_identity_id: identityId,
          entity_key: entityKey,
          entity_canon: entity.canon,
          attr: claim.slot.attr
        }
      })
      relations.push({
        type: "INDEX_FILLS",
        srcLabel: "IndexClaim",
        srcKey: key,
        dstLabel: "IndexSlot",
        dstKey: slotKey,
        properties: source
      })
    }

    const tokens = claimTokens({
      text: claim.text,
      keywords: claim.keywords,
      entityNames: claim.entities.flatMap((entity) => [entity.canon, ...entity.aliases])
    })
    for (const stem of tokens) {
      const tokenKey = indexTokenKey(
        revision.uid,
        generation.id,
        revision.logicalSessionId,
        revision.sourceDigest,
        stem
      )
      tokensByKey.set(tokenKey, {
        key: tokenKey,
        properties: { ...source, index_token: tokenKey, stem }
      })
      relations.push({
        type: "INDEX_HITS",
        srcLabel: "IndexToken",
        srcKey: tokenKey,
        dstLabel: "IndexClaim",
        dstKey: key,
        properties: source
      })
    }
  }

  for (const identity of entityIdentities) {
    const entity = entitiesByIdentity.get(identity.id)
    const entityKey = entityKeyByIdentity.get(identity.id)
    if (entity === undefined || entityKey === undefined) throw new Error("entity token source was not readable")
    const names = [entity.canon, ...entity.aliases]
    for (const stem of new Set(names.flatMap((name) => claimTokens({ text: name, keywords: [], entityNames: [] })))) {
      const tokenKey = indexTokenKey(
        revision.uid,
        generation.id,
        revision.logicalSessionId,
        revision.sourceDigest,
        stem
      )
      tokensByKey.set(tokenKey, {
        key: tokenKey,
        properties: { ...source, index_token: tokenKey, stem }
      })
      relations.push({
        type: "INDEX_NAMES",
        srcLabel: "IndexToken",
        srcKey: tokenKey,
        dstLabel: "IndexEntity",
        dstKey: entityKey,
        properties: source
      })
    }
  }

  return Either.right({
    generationId: generation.id,
    sourceDigest: revision.sourceDigest,
    entityIdentities,
    entities,
    claims: claimsOut,
    slots: [...slotsByKey.values()],
    tokens: [...tokensByKey.values()],
    relations
  })
}

const make = Effect.gen(function* () {
  const hydra = yield* HydraClient

  const write = (
    input: PlanIndexGraphWrite
  ): Effect.Effect<IndexGraphWriteReport, HydraError | IndexGraphWriteRejected> =>
    Effect.gen(function* () {
      const plan = planIndexGraphWrite(input)
      if (plan._tag === "Left") return yield* Effect.fail(plan.left)
      yield* hydra.batchMerge("IndexEntity", plan.right.entities)
      yield* hydra.batchMerge("IndexClaim", plan.right.claims)
      yield* hydra.batchMerge("IndexSlot", plan.right.slots)
      yield* hydra.batchMerge("IndexToken", plan.right.tokens)
      for (const type of ["INDEX_EVIDENCE", "INDEX_MENTIONS", "INDEX_FILLS", "INDEX_HITS", "INDEX_NAMES"] as const) {
        const relations = plan.right.relations.filter((relation) => relation.type === type)
        if (relations.length > 0) yield* hydra.batchRel(type, relations)
      }
      return {
        generationId: plan.right.generationId,
        sourceDigest: plan.right.sourceDigest,
        entities: plan.right.entities.length,
        claims: plan.right.claims.length,
        slots: plan.right.slots.length,
        tokens: plan.right.tokens.length
      }
    })

  return { write } as const
})

/** Isolated derived graph writer; legacy claim labels are intentionally untouched. */
export class IndexGraph extends Effect.Service<IndexGraph>()("palimpsest/IndexGraph", { effect: make }) {}
