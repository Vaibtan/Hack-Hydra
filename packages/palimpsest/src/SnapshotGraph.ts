import { createHash } from "node:crypto"
import {
  HydraMemory,
  type HydraError,
  type MemoryPath,
  type MemoryProperties,
  type PropertyValue,
  type RelDirection
} from "@palimpsest/hydra"
import { Context, Data, Effect, Layer, Option, Result } from "effect"
import { claimDigest } from "./ClaimGraph.js"
import type { EntityCanonicalView } from "./EntityCanonicalView.js"
import type { ExtractionArtifact } from "./ExtractionArtifact.js"
import type { ExtractedEntity } from "./Extract.js"
import { claimSnapshotGraphPlan } from "./GraphIdClaims.js"
import { indexEntityIdentityId } from "./IndexGraph.js"
import type { IndexGeneration } from "./IndexGeneration.js"
import {
  EntityCanonicalViewNotFound,
  IndexGenerationNotFound,
  IngestManifest,
  SnapshotVerificationConflict,
  UserIndexSnapshotNotFound,
  type GraphIdCollision,
  type IngestManifestUnavailable,
  type InvalidGraphIdClaim,
  type InvalidSnapshotTransition,
  type InvalidSnapshotUpdate,
  type SnapshotProjectionCounts,
  type SourceRevision,
  type UserIndexSnapshotRecord
} from "./IngestManifest.js"
import { frameSegment, scopePrefix, type MemoryScope } from "./MemoryScope.js"
import { canonicalJson, type CanonicalJson } from "./SourceIdentity.js"
import { sourceSessionKey, sourceTurnKey } from "./SourceTranscript.js"
import { claimTokens } from "./Tokenize.js"
import type { UserIndexSnapshot } from "./UserIndexSnapshot.js"

// HydraDB has no list type; aliases are one string joined by the ASCII unit separator.
const ALIAS_SEPARATOR = "\u001f"

/** Read-time compatibility marker for the materialized snapshot projection. */
export const SNAPSHOT_GRAPH_FORMAT = "palimpsest.snapshot-graph.v2"

/**
 * Snapshot graph keys are tenant-and-snapshot scoped (S03): the same digest,
 * generation and claim content produce different keys under a different
 * snapshot, so a building projection can never be reached through another
 * snapshot's identities. Digests and ids stay bare only because they are
 * code-generated `[A-Za-z0-9-]` values; every caller-controlled segment
 * (attr, stem) is length-prefixed.
 */
export const snapshotRootKey = (scope: MemoryScope, snapshotId: string): string =>
  `${scopePrefix(scope)}|snap|${snapshotId}`

export const snapshotRevisionKey = (
  scope: MemoryScope,
  snapshotId: string,
  commitId: string
): string => `${snapshotRootKey(scope, snapshotId)}|rev|${commitId}`

export const snapshotEntityKey = (
  scope: MemoryScope,
  snapshotId: string,
  canonicalIdentityId: string
): string => `${snapshotRootKey(scope, snapshotId)}|entity|${canonicalIdentityId}`

export const snapshotClaimKey = (
  scope: MemoryScope,
  snapshotId: string,
  commitId: string,
  digest: string
): string => `${snapshotRootKey(scope, snapshotId)}|claim|${commitId}|${digest}`

export const snapshotEvidenceKey = (
  scope: MemoryScope,
  snapshotId: string,
  commitId: string,
  turnIdx: number
): string => `${snapshotRootKey(scope, snapshotId)}|evidence|${commitId}|${turnIdx}`

export const snapshotSlotKey = (
  scope: MemoryScope,
  snapshotId: string,
  canonicalIdentityId: string,
  attr: string
): string =>
  `${snapshotRootKey(scope, snapshotId)}|slot|${canonicalIdentityId}|${frameSegment(attr)}`

export const snapshotTokenKey = (scope: MemoryScope, snapshotId: string, stem: string): string =>
  `${snapshotRootKey(scope, snapshotId)}|token|${frameSegment(stem)}`

export type SnapshotVertexLabel =
  | "SnapshotRoot"
  | "SnapshotRevision"
  | "SnapshotEntity"
  | "SnapshotClaim"
  | "SnapshotEvidence"
  | "SnapshotSlot"
  | "SnapshotToken"

export type SnapshotRelationType =
  | "SNAPSHOT_HAS_REVISION"
  | "SNAPSHOT_HAS_ENTITY"
  | "SNAPSHOT_HAS_SLOT"
  | "SNAPSHOT_HAS_TOKEN"
  | "SNAPSHOT_HAS_CLAIM"
  | "SNAPSHOT_HAS_EVIDENCE"
  | "SNAPSHOT_DERIVED_FROM"
  | "SNAPSHOT_EVIDENCE"
  | "SNAPSHOT_MENTIONS"
  | "SNAPSHOT_FILLS"
  | "SNAPSHOT_HITS"
  | "SNAPSHOT_NAMES"
  | "SNAPSHOT_SUPERSEDED_BY"

/** The key-bearing property each label writes; also the msPaths source selector. */
const KEY_PROPERTY: Readonly<Record<SnapshotVertexLabel, string>> = {
  SnapshotRoot: "snapshot_root",
  SnapshotRevision: "snapshot_revision",
  SnapshotEntity: "snapshot_entity",
  SnapshotClaim: "snapshot_claim",
  SnapshotEvidence: "snapshot_evidence",
  SnapshotSlot: "snapshot_slot",
  SnapshotToken: "snapshot_token"
}

const MEMBER_RELATIONS: Readonly<Partial<Record<SnapshotVertexLabel, SnapshotRelationType>>> = {
  SnapshotRevision: "SNAPSHOT_HAS_REVISION",
  SnapshotEntity: "SNAPSHOT_HAS_ENTITY",
  SnapshotSlot: "SNAPSHOT_HAS_SLOT",
  SnapshotToken: "SNAPSHOT_HAS_TOKEN",
  SnapshotClaim: "SNAPSHOT_HAS_CLAIM",
  SnapshotEvidence: "SNAPSHOT_HAS_EVIDENCE"
}

const MEMBER_RELATION_TYPES: ReadonlyArray<SnapshotRelationType> = [
  "SNAPSHOT_HAS_REVISION",
  "SNAPSHOT_HAS_ENTITY",
  "SNAPSHOT_HAS_SLOT",
  "SNAPSHOT_HAS_TOKEN",
  "SNAPSHOT_HAS_CLAIM",
  "SNAPSHOT_HAS_EVIDENCE"
]

const MEMBER_WRITE_ORDER: ReadonlyArray<Exclude<SnapshotVertexLabel, "SnapshotRoot">> = [
  "SnapshotRevision",
  "SnapshotEntity",
  "SnapshotSlot",
  "SnapshotToken",
  "SnapshotClaim",
  "SnapshotEvidence"
]

const RELATION_WRITE_ORDER: ReadonlyArray<SnapshotRelationType> = [
  "SNAPSHOT_HAS_REVISION",
  "SNAPSHOT_HAS_ENTITY",
  "SNAPSHOT_HAS_SLOT",
  "SNAPSHOT_HAS_TOKEN",
  "SNAPSHOT_HAS_CLAIM",
  "SNAPSHOT_HAS_EVIDENCE",
  "SNAPSHOT_DERIVED_FROM",
  "SNAPSHOT_EVIDENCE",
  "SNAPSHOT_MENTIONS",
  "SNAPSHOT_FILLS",
  "SNAPSHOT_HITS",
  "SNAPSHOT_NAMES",
  "SNAPSHOT_SUPERSEDED_BY"
]

/** The props a build needs off the durable SourceSession vertex. */
const SOURCE_SESSION_PROPERTIES = ["sid", "session_ord", "date", "n_turns"] as const

/** msPaths source lists degrade above ~2 000 keys; verify walks stay well inside. */
const VERIFY_SOURCES_PER_WALK = 200

export class SnapshotGraphPlanRejected extends Data.TaggedError("SnapshotGraphPlanRejected")<{
  readonly snapshotId: string
  readonly reason:
    | "missingSourceRevision"
    | "unlistedSourceRevision"
    | "duplicateSourceRevision"
    | "revisionScopeMismatch"
    | "revisionNotReady"
    | "extractionGenerationMismatch"
    | "artifactBindingMismatch"
    | "sourceSessionMismatch"
    | "unknownTurn"
    | "invalidSpan"
    | "entityNotInCanonicalView"
    | "canonicalIdentityMissing"
    | "unknownCausalEndpoint"
    | "invalidCausalLink"
  readonly detail: string
}> {
  override get message(): string {
    return `Snapshot graph ${this.snapshotId} plan rejected: ${this.reason} (${this.detail})`
  }
}

export class SnapshotGraphBuildRejected extends Data.TaggedError("SnapshotGraphBuildRejected")<{
  readonly snapshotId: string
  readonly reason:
    | "failedState"
    | "missingSourceRevision"
    | "missingExtractionArtifact"
    | "missingSourceSession"
  readonly detail: string
}> {
  override get message(): string {
    return `Snapshot graph ${this.snapshotId} build rejected: ${this.reason} (${this.detail})`
  }
}

export class SnapshotGraphVerifyRejected extends Data.TaggedError("SnapshotGraphVerifyRejected")<{
  readonly snapshotId: string
  readonly reason:
    | "missingRoot"
    | "rootMismatch"
    | "missingMember"
    | "memberMismatch"
    | "unexpectedMember"
    | "missingRelationship"
    | "relationshipMismatch"
    | "unexpectedRelationship"
    | "digestMismatch"
  readonly detail: string
}> {
  override get message(): string {
    return `Snapshot graph ${this.snapshotId} verification rejected: ${this.reason} (${this.detail})`
  }
}

export interface SnapshotGraphVertex {
  readonly label: SnapshotVertexLabel
  readonly key: string
  readonly properties: Readonly<Record<string, PropertyValue>>
}

export interface SnapshotGraphRelation {
  readonly type: SnapshotRelationType
  readonly srcLabel: SnapshotVertexLabel
  readonly srcKey: string
  readonly dstLabel: SnapshotVertexLabel
  readonly dstKey: string
  readonly properties: Readonly<Record<string, PropertyValue>>
}

/** Session header fields read back off the durable SourceSession vertex. */
export interface SnapshotSourceSession {
  readonly sid: string
  readonly sessionOrd: number
  readonly dateInt: number
  readonly turns: number
}

/** One committed source revision with its durable inputs. */
export interface SnapshotGraphSource {
  readonly revision: SourceRevision
  readonly artifact: ExtractionArtifact
  readonly session: SnapshotSourceSession
}

/** A claim addressed by its revision commit id and content digest. */
export interface SnapshotClaimReference {
  readonly commitId: string
  readonly claimDigest: string
}

/**
 * One decided supersession fact (S04 enrichment supplies these). The build
 * only resolves endpoints and stamps `at_session` from the newer claim's
 * session ordinal — the relation itself is input, never derived here.
 */
export interface SnapshotCausalLink {
  readonly older: SnapshotClaimReference
  readonly newer: SnapshotClaimReference
}

export interface PlanSnapshotGraph {
  readonly snapshot: UserIndexSnapshot
  readonly generation: IndexGeneration
  readonly view: EntityCanonicalView
  readonly sources: ReadonlyArray<SnapshotGraphSource>
  readonly causalLinks: ReadonlyArray<SnapshotCausalLink>
}

export interface SnapshotGraphPlan {
  readonly snapshotId: string
  readonly root: SnapshotGraphVertex
  readonly members: ReadonlyArray<SnapshotGraphVertex>
  readonly relations: ReadonlyArray<SnapshotGraphRelation>
  /** sha256 of the canonical vertex+relationship serialization; verification re-derives it from read-back. */
  readonly digest: string
  readonly counts: SnapshotProjectionCounts
}

export interface BuildSnapshotGraph {
  readonly snapshotId: string
  readonly causalLinks: ReadonlyArray<SnapshotCausalLink>
}

const snapshotDigest = (
  snapshotId: string,
  vertices: ReadonlyArray<{
    readonly key: string
    readonly label: string
    readonly properties: Readonly<Record<string, PropertyValue>>
  }>,
  relations: ReadonlyArray<{
    readonly type: string
    readonly srcKey: string
    readonly dstKey: string
    readonly properties: Readonly<Record<string, PropertyValue>>
  }>
): string =>
  createHash("sha256")
    .update(
      canonicalJson({
        format: SNAPSHOT_GRAPH_FORMAT,
        snapshot_id: snapshotId,
        vertices: vertices.map(
          (vertex): CanonicalJson => ({
            key: vertex.key,
            label: vertex.label,
            properties: vertex.properties
          })
        ),
        relationships: relations.map(
          (relation): CanonicalJson => ({
            dst: relation.dstKey,
            properties: relation.properties,
            src: relation.srcKey,
            type: relation.type
          })
        )
      }),
      "utf8"
    )
    .digest("hex")

const byVertexOrder = (
  left: { readonly label: string; readonly key: string },
  right: { readonly label: string; readonly key: string }
): number => left.label.localeCompare(right.label) || left.key.localeCompare(right.key)

const byRelationOrder = (
  left: { readonly type: string; readonly srcKey: string; readonly dstKey: string },
  right: { readonly type: string; readonly srcKey: string; readonly dstKey: string }
): number =>
  left.type.localeCompare(right.type) ||
  left.srcKey.localeCompare(right.srcKey) ||
  left.dstKey.localeCompare(right.dstKey)

/**
 * Pure plan of the whole snapshot graph (S03): entities resolved through the
 * pinned canonical view, slots aggregated across revisions, tokens with
 * document frequency, per-claim revision/turn provenance, and caller-decided
 * causal links. Source order does not matter — every key is content-derived
 * and both outputs are sorted before the digest is taken.
 */
export const planSnapshotGraph = (
  input: PlanSnapshotGraph
): Result.Result<SnapshotGraphPlan, SnapshotGraphPlanRejected> => {
  const { snapshot, generation, view, sources, causalLinks } = input
  const scope = snapshot.scope
  const snapshotId = snapshot.id
  const fail = (
    reason: SnapshotGraphPlanRejected["reason"],
    detail: string
  ): Result.Result<SnapshotGraphPlan, SnapshotGraphPlanRejected> =>
    Result.fail(new SnapshotGraphPlanRejected({ snapshotId, reason, detail }))

  const listed = new Set(snapshot.sourceCommitIds)
  const byCommitId = new Map<string, SnapshotGraphSource>()
  for (const source of sources) {
    const commitId = source.revision.commitId
    if (!listed.has(commitId)) return fail("unlistedSourceRevision", commitId)
    if (byCommitId.has(commitId)) return fail("duplicateSourceRevision", commitId)
    byCommitId.set(commitId, source)
  }
  const ordered: Array<SnapshotGraphSource> = []
  for (const commitId of snapshot.sourceCommitIds) {
    const source = byCommitId.get(commitId)
    if (source === undefined) return fail("missingSourceRevision", commitId)
    ordered.push(source)
  }

  for (const { revision, artifact, session } of ordered) {
    if (revision.tenant !== scope.tenantId || revision.uid !== scope.uid) {
      return fail("revisionScopeMismatch", revision.commitId)
    }
    // ENRICHED is the first state where every per-revision durable input
    // (transcript, index graph, artifact, supersession decisions) exists, so a
    // build is reproducible from it onward. COMMITTED is enforced separately by
    // the terminal activation transaction before the snapshot can go live.
    if (
      revision.state !== "ENRICHED" &&
      revision.state !== "CONSOLIDATED" &&
      revision.state !== "COMMITTED"
    ) {
      return fail("revisionNotReady", `${revision.commitId} at ${revision.state}`)
    }
    if (revision.extractionGeneration !== generation.extractionGenerationId) {
      return fail(
        "extractionGenerationMismatch",
        `${revision.commitId} extracted by ${revision.extractionGeneration}, generation pins ${generation.extractionGenerationId}`
      )
    }
    if (
      artifact.commitId !== revision.commitId ||
      artifact.sourceDigest !== revision.sourceDigest ||
      artifact.extractionGeneration !== revision.extractionGeneration
    ) {
      return fail("artifactBindingMismatch", revision.commitId)
    }
    if (
      session.sid !== artifact.extraction.sid ||
      !Number.isSafeInteger(session.sessionOrd) ||
      !Number.isSafeInteger(session.dateInt) ||
      !Number.isSafeInteger(session.turns) ||
      session.sessionOrd !== revision.sessionOrdinal
    ) {
      return fail("sourceSessionMismatch", revision.commitId)
    }
    for (const claim of artifact.extraction.claims) {
      if (
        !Number.isSafeInteger(claim.span.turnIdx) ||
        claim.span.turnIdx < 0 ||
        claim.span.turnIdx >= session.turns
      ) {
        return fail("unknownTurn", `${revision.commitId} turn ${claim.span.turnIdx}`)
      }
      if (
        !Number.isSafeInteger(claim.span.cs) ||
        !Number.isSafeInteger(claim.span.ce) ||
        claim.span.cs < 0 ||
        claim.span.ce <= claim.span.cs
      ) {
        return fail("invalidSpan", `${revision.commitId} turn ${claim.span.turnIdx}`)
      }
    }
  }

  // First pass: collect every extracted (or slot-implied) identity and resolve
  // it through the pinned canonical view. Identity ids are content addresses —
  // equal ids carry equal content, so re-setting is harmless.
  const entitiesByIdentity = new Map<string, ExtractedEntity>()
  const canonicalByIdentity = new Map<string, string>()
  const canonicalMembers = new Map<string, Set<string>>()
  const perSourceCanons = ordered.map(({ artifact }) => {
    const canons = new Map<string, ExtractedEntity>()
    for (const claim of artifact.extraction.claims) {
      for (const entity of claim.entities) {
        if (!canons.has(entity.canon)) canons.set(entity.canon, entity)
      }
    }
    return canons
  })
  const registerEntity = (entity: ExtractedEntity): string | null => {
    const identityId = indexEntityIdentityId(entity)
    entitiesByIdentity.set(identityId, entity)
    const canonicalId = view.resolutions.get(identityId)
    if (canonicalId === undefined) return null
    canonicalByIdentity.set(identityId, canonicalId)
    const members = canonicalMembers.get(canonicalId) ?? new Set<string>()
    members.add(identityId)
    canonicalMembers.set(canonicalId, members)
    return canonicalId
  }
  for (const [index, { artifact }] of ordered.entries()) {
    const canons = perSourceCanons[index]
    if (canons === undefined) throw new Error("source canon map was not prepared")
    for (const claim of artifact.extraction.claims) {
      for (const entity of claim.entities) {
        if (registerEntity(entity) === null) {
          return fail("entityNotInCanonicalView", indexEntityIdentityId(entity))
        }
      }
      if (claim.slot !== null) {
        const entity =
          canons.get(claim.slot.entityCanon) ??
          ({ canon: claim.slot.entityCanon, etype: "topic", aliases: [] } as const)
        if (registerEntity(entity) === null) {
          return fail("entityNotInCanonicalView", indexEntityIdentityId(entity))
        }
      }
    }
  }

  // Canonical entity vertices: display = canonical member's canon/etype, names =
  // every member's canon+aliases so NAME edges cover all observed names.
  const rootKey = snapshotRootKey(scope, snapshotId)
  const base = { snapshot_id: snapshotId, tenant: scope.tenantId, uid: scope.uid }
  const entityVertices = new Map<string, SnapshotGraphVertex>()
  const entityKeyByCanonical = new Map<string, string>()
  const entityNamesByCanonical = new Map<string, ReadonlyArray<string>>()
  for (const [canonicalId, memberIds] of canonicalMembers) {
    const canonical = entitiesByIdentity.get(canonicalId)
    if (canonical === undefined) {
      return fail("canonicalIdentityMissing", canonicalId)
    }
    const names = new Set<string>()
    for (const memberId of memberIds) {
      const member = entitiesByIdentity.get(memberId)
      if (member === undefined) throw new Error("canonical view member was not collected")
      names.add(member.canon)
      for (const alias of member.aliases) names.add(alias)
    }
    names.delete(canonical.canon)
    const aliases = [...names].sort((left, right) => left.localeCompare(right))
    const key = snapshotEntityKey(scope, snapshotId, canonicalId)
    entityKeyByCanonical.set(canonicalId, key)
    entityNamesByCanonical.set(canonicalId, [canonical.canon, ...aliases])
    entityVertices.set(canonicalId, {
      label: "SnapshotEntity",
      key,
      properties: {
        ...base,
        snapshot_entity: key,
        canonical_identity_id: canonicalId,
        canon: canonical.canon,
        etype: canonical.etype,
        aliases: aliases.join(ALIAS_SEPARATOR),
        n_member_identities: memberIds.size
      }
    })
  }

  const relationsById = new Map<string, SnapshotGraphRelation>()
  const addRelation = (relation: SnapshotGraphRelation): void => {
    const id = JSON.stringify([relation.type, relation.srcKey, relation.dstKey])
    const existing = relationsById.get(id)
    if (existing !== undefined) {
      if (canonicalJson(existing.properties) !== canonicalJson(relation.properties)) {
        throw new Error("snapshot plan produced two relationships under one identity")
      }
      return
    }
    relationsById.set(id, relation)
  }

  const claimVertices = new Map<string, SnapshotGraphVertex>()
  const evidenceVertices = new Map<string, SnapshotGraphVertex>()
  const claimKeyByReference = new Map<string, string>()
  const sessionOrdByClaimKey = new Map<string, number>()
  const revisionVertices = new Map<string, SnapshotGraphVertex>()
  const slotAccum = new Map<
    string,
    { readonly canonicalId: string; readonly canon: string; readonly attr: string; readonly claims: Set<string> }
  >()
  const tokenAccum = new Map<string, { readonly stem: string; readonly hits: Set<string> }>()
  const tokenFor = (stem: string): string => {
    const key = snapshotTokenKey(scope, snapshotId, stem)
    const entry = tokenAccum.get(key) ?? { stem, hits: new Set<string>() }
    tokenAccum.set(key, entry)
    return key
  }

  for (const [index, { revision, artifact, session }] of ordered.entries()) {
    const canons = perSourceCanons[index]
    if (canons === undefined) throw new Error("source canon map was not prepared")
    const revisionKey = snapshotRevisionKey(scope, snapshotId, revision.commitId)
    const revisionClaims = new Set<string>()

    for (const claim of artifact.extraction.claims) {
      const digest = claimDigest(claim, revision.logicalSessionId)
      const claimKey = snapshotClaimKey(scope, snapshotId, revision.commitId, digest)
      claimKeyByReference.set(JSON.stringify([revision.commitId, digest]), claimKey)
      sessionOrdByClaimKey.set(claimKey, revision.sessionOrdinal)
      revisionClaims.add(claimKey)
      claimVertices.set(claimKey, {
        label: "SnapshotClaim",
        key: claimKey,
        properties: {
          ...base,
          snapshot_claim: claimKey,
          commit_id: revision.commitId,
          claim_digest: digest,
          logical_session_id: revision.logicalSessionId,
          source_digest: revision.sourceDigest,
          accepted_at_ms: revision.acceptedAtMs,
          sid: artifact.extraction.sid,
          session_ord: revision.sessionOrdinal,
          session_date: session.dateInt,
          text: claim.text,
          speaker: claim.speaker,
          ctype: claim.ctype,
          t_event: claim.tEvent,
          t_prec: claim.tPrec,
          turn_idx: claim.span.turnIdx,
          cs: claim.span.cs,
          ce: claim.span.ce,
          located: claim.located
        }
      })
      addRelation({
        type: "SNAPSHOT_DERIVED_FROM",
        srcLabel: "SnapshotClaim",
        srcKey: claimKey,
        dstLabel: "SnapshotRevision",
        dstKey: revisionKey,
        properties: base
      })
      addRelation({
        type: "SNAPSHOT_EVIDENCE",
        srcLabel: "SnapshotClaim",
        srcKey: claimKey,
        dstLabel: "SnapshotEvidence",
        dstKey: snapshotEvidenceKey(scope, snapshotId, revision.commitId, claim.span.turnIdx),
        properties: { ...base, cs: claim.span.cs, ce: claim.span.ce }
      })
      const evidenceKey = snapshotEvidenceKey(scope, snapshotId, revision.commitId, claim.span.turnIdx)
      if (!evidenceVertices.has(evidenceKey)) {
        evidenceVertices.set(evidenceKey, {
          label: "SnapshotEvidence",
          key: evidenceKey,
          properties: {
            ...base,
            snapshot_evidence: evidenceKey,
            commit_id: revision.commitId,
            logical_session_id: revision.logicalSessionId,
            source_digest: revision.sourceDigest,
            turn_idx: claim.span.turnIdx,
            source_turn_key: sourceTurnKey(
              scope,
              revision.logicalSessionId,
              revision.sourceDigest,
              claim.span.turnIdx
            )
          }
        })
      }

      for (const entity of claim.entities) {
        const canonicalId = canonicalByIdentity.get(indexEntityIdentityId(entity))
        if (canonicalId === undefined) throw new Error("claim entity was not resolved")
        const entityKey = entityKeyByCanonical.get(canonicalId)
        if (entityKey === undefined) throw new Error("claim entity was not prepared")
        addRelation({
          type: "SNAPSHOT_MENTIONS",
          srcLabel: "SnapshotEntity",
          srcKey: entityKey,
          dstLabel: "SnapshotClaim",
          dstKey: claimKey,
          properties: base
        })
      }

      if (claim.slot !== null) {
        const entity =
          canons.get(claim.slot.entityCanon) ??
          ({ canon: claim.slot.entityCanon, etype: "topic", aliases: [] } as const)
        const canonicalId = canonicalByIdentity.get(indexEntityIdentityId(entity))
        if (canonicalId === undefined) throw new Error("slot entity was not resolved")
        const entityKey = entityKeyByCanonical.get(canonicalId)
        const canonical = entityVertices.get(canonicalId)
        if (entityKey === undefined || canonical === undefined) {
          throw new Error("slot entity was not prepared")
        }
        const slotKey = snapshotSlotKey(scope, snapshotId, canonicalId, claim.slot.attr)
        const slot = slotAccum.get(slotKey) ?? {
          canonicalId,
          canon: String(canonical.properties["canon"]),
          attr: claim.slot.attr,
          claims: new Set<string>()
        }
        slot.claims.add(claimKey)
        slotAccum.set(slotKey, slot)
        addRelation({
          type: "SNAPSHOT_FILLS",
          srcLabel: "SnapshotClaim",
          srcKey: claimKey,
          dstLabel: "SnapshotSlot",
          dstKey: slotKey,
          properties: base
        })
      }

      const tokens = claimTokens({
        text: claim.text,
        keywords: claim.keywords,
        entityNames: claim.entities.flatMap((entity) => [entity.canon, ...entity.aliases])
      })
      for (const stem of tokens) {
        const tokenKey = tokenFor(stem)
        const entry = tokenAccum.get(tokenKey)
        if (entry === undefined) throw new Error("token was not prepared")
        entry.hits.add(claimKey)
        addRelation({
          type: "SNAPSHOT_HITS",
          srcLabel: "SnapshotToken",
          srcKey: tokenKey,
          dstLabel: "SnapshotClaim",
          dstKey: claimKey,
          properties: base
        })
      }
    }

    revisionVertices.set(revision.commitId, {
      label: "SnapshotRevision",
      key: revisionKey,
      properties: {
        ...base,
        snapshot_revision: revisionKey,
        commit_id: revision.commitId,
        logical_session_id: revision.logicalSessionId,
        source_digest: revision.sourceDigest,
        source_bytes: revision.sourceBytes,
        accepted_at_ms: revision.acceptedAtMs,
        session_ord: revision.sessionOrdinal,
        extraction_generation: revision.extractionGeneration,
        artifact_id: artifact.id,
        n_claims: revisionClaims.size
      }
    })
  }

  // NAME edges: stems of every resolved member name hit the canonical entity.
  for (const [canonicalId, names] of entityNamesByCanonical) {
    const entityKey = entityKeyByCanonical.get(canonicalId)
    if (entityKey === undefined) throw new Error("canonical entity was not prepared")
    const stems = new Set<string>()
    for (const name of names) {
      for (const stem of claimTokens({ text: name, keywords: [], entityNames: [] })) stems.add(stem)
    }
    for (const stem of [...stems].sort((left, right) => left.localeCompare(right))) {
      const tokenKey = tokenFor(stem)
      addRelation({
        type: "SNAPSHOT_NAMES",
        srcLabel: "SnapshotToken",
        srcKey: tokenKey,
        dstLabel: "SnapshotEntity",
        dstKey: entityKey,
        properties: base
      })
    }
  }

  // Caller-decided causal links, folded deterministically: endpoints must name
  // claims in this snapshot, and `at_session` is the newer claim's ordinal.
  const seenCausalLinks = new Set<string>()
  for (const link of causalLinks) {
    const olderKey = claimKeyByReference.get(
      JSON.stringify([link.older.commitId, link.older.claimDigest])
    )
    const newerKey = claimKeyByReference.get(
      JSON.stringify([link.newer.commitId, link.newer.claimDigest])
    )
    if (olderKey === undefined) {
      return fail("unknownCausalEndpoint", `older ${link.older.commitId}/${link.older.claimDigest}`)
    }
    if (newerKey === undefined) {
      return fail("unknownCausalEndpoint", `newer ${link.newer.commitId}/${link.newer.claimDigest}`)
    }
    if (olderKey === newerKey) {
      return fail("invalidCausalLink", `${link.older.commitId}/${link.older.claimDigest} is a self link`)
    }
    const olderOrd = sessionOrdByClaimKey.get(olderKey)
    const newerOrd = sessionOrdByClaimKey.get(newerKey)
    if (olderOrd === undefined || newerOrd === undefined) {
      throw new Error("causal endpoint was not prepared")
    }
    if (newerOrd < olderOrd) {
      return fail(
        "invalidCausalLink",
        `${link.newer.commitId}/${link.newer.claimDigest} (session ${newerOrd}) precedes ${link.older.commitId}/${link.older.claimDigest} (session ${olderOrd})`
      )
    }
    const pairId = JSON.stringify([olderKey, newerKey])
    if (seenCausalLinks.has(pairId)) continue
    seenCausalLinks.add(pairId)
    addRelation({
      type: "SNAPSHOT_SUPERSEDED_BY",
      srcLabel: "SnapshotClaim",
      srcKey: olderKey,
      dstLabel: "SnapshotClaim",
      dstKey: newerKey,
      properties: { ...base, at_session: newerOrd }
    })
  }

  const members: Array<SnapshotGraphVertex> = []
  for (const [slotKey, slot] of slotAccum) {
    const entityKey = entityKeyByCanonical.get(slot.canonicalId)
    if (entityKey === undefined) throw new Error("slot entity was not prepared")
    members.push({
      label: "SnapshotSlot",
      key: slotKey,
      properties: {
        ...base,
        snapshot_slot: slotKey,
        canonical_identity_id: slot.canonicalId,
        entity_key: entityKey,
        entity_canon: slot.canon,
        attr: slot.attr,
        n_claims: slot.claims.size
      }
    })
  }
  for (const [tokenKey, token] of tokenAccum) {
    members.push({
      label: "SnapshotToken",
      key: tokenKey,
      properties: { ...base, snapshot_token: tokenKey, stem: token.stem, df: token.hits.size }
    })
  }
  members.push(
    ...revisionVertices.values(),
    ...entityVertices.values(),
    ...claimVertices.values(),
    ...evidenceVertices.values()
  )
  members.sort(byVertexOrder)
  // HAS_* edges are added here, once per member vertex — they enumerate the
  // namespace in one walk and give verification its cardinality coverage.
  for (const member of members) {
    const type = MEMBER_RELATIONS[member.label]
    if (type === undefined) throw new Error("root vertex must not appear among members")
    addRelation({
      type,
      srcLabel: "SnapshotRoot",
      srcKey: rootKey,
      dstLabel: member.label,
      dstKey: member.key,
      properties: base
    })
  }

  const relations = [...relationsById.values()].sort(byRelationOrder)
  const root: SnapshotGraphVertex = {
    label: "SnapshotRoot",
    key: rootKey,
    properties: {
      ...base,
      snapshot_root: rootKey,
      graph_format: SNAPSHOT_GRAPH_FORMAT,
      index_generation: snapshot.indexGenerationId,
      canonical_view_id: snapshot.canonicalViewId,
      manifest_schema_version: snapshot.manifestSchemaVersion,
      source_revisions_hash: snapshot.sourceRevisionsHash,
      n_revisions: revisionVertices.size,
      n_entities: entityVertices.size,
      n_claims: claimVertices.size,
      n_evidence: evidenceVertices.size,
      n_slots: slotAccum.size,
      n_tokens: tokenAccum.size
    }
  }
  const vertices = [root, ...members]
  return Result.succeed({
    snapshotId,
    root,
    members,
    relations,
    digest: snapshotDigest(snapshotId, vertices, relations),
    counts: {
      sourceRevisions: ordered.length,
      vertices: vertices.length,
      relationships: relations.length
    }
  })
}

export type SnapshotGraphError =
  | SnapshotGraphBuildRejected
  | SnapshotGraphPlanRejected
  | SnapshotGraphVerifyRejected
  | EntityCanonicalViewNotFound
  | GraphIdCollision
  | IndexGenerationNotFound
  | InvalidGraphIdClaim
  | InvalidSnapshotTransition
  | InvalidSnapshotUpdate
  | IngestManifestUnavailable
  | SnapshotVerificationConflict
  | UserIndexSnapshotNotFound
  | HydraError

interface ObservedVertex {
  readonly label: string
  readonly key: string
  readonly properties: Record<string, PropertyValue>
}

interface ObservedRelation {
  readonly type: string
  readonly srcKey: string
  readonly dstKey: string
  readonly properties: Record<string, PropertyValue>
}

/** Memory property bags are scalars and exclude the adapter's identity property. */
const vertexProperties = (properties: MemoryProperties) => ({ ...properties })

const relationProperties = (properties: MemoryProperties): Record<string, PropertyValue> =>
  Object.fromEntries(
    Object.entries(properties).filter(([name]) => name !== "id")
  )

const chunksOf = <A>(items: ReadonlyArray<A>, size: number): ReadonlyArray<ReadonlyArray<A>> => {
  const out: Array<ReadonlyArray<A>> = []
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size))
  return out
}

const make = Effect.gen(function* () {
  const hydra = yield* HydraMemory
  const manifest = yield* IngestManifest

  const gatherSource = (scope: MemoryScope, snapshotId: string, commitId: string) =>
    Effect.gen(function* () {
      const revision = yield* manifest.readSourceRevisionByCommitId(commitId)
      if (revision === null) {
        return yield* Effect.fail(
          new SnapshotGraphBuildRejected({
            snapshotId,
            reason: "missingSourceRevision",
            detail: commitId
          })
        )
      }
      const artifact = yield* manifest.readExtractionArtifact(revision)
      if (artifact === null) {
        return yield* Effect.fail(
          new SnapshotGraphBuildRejected({
            snapshotId,
            reason: "missingExtractionArtifact",
            detail: commitId
          })
        )
      }
      const row = yield* hydra.resolveNode({
        label: "SourceSession",
        key: sourceSessionKey(scope, revision.logicalSessionId, revision.sourceDigest),
        properties: [...SOURCE_SESSION_PROPERTIES]
      })
      if (Option.isNone(row)) {
        return yield* Effect.fail(
          new SnapshotGraphBuildRejected({
            snapshotId,
            reason: "missingSourceSession",
            detail: commitId
          })
        )
      }
      const session: SnapshotSourceSession = {
        sid: String(row.value.properties["sid"] ?? ""),
        sessionOrd: Number(row.value.properties["session_ord"]),
        dateInt: Number(row.value.properties["date"]),
        turns: Number(row.value.properties["n_turns"])
      }
      return { revision, artifact, session } satisfies SnapshotGraphSource
    })

  const writePlan = (plan: SnapshotGraphPlan) =>
    hydra.commitWrites({ vertices: [plan.root, ...plan.members], edges: plan.relations })

  /**
   * Read-back (S03): enumerate the whole namespace via the HAS edges, walk the
   * claim/entity/token projections in bounded source lists, diff every vertex
   * and relationship against the plan, and only then recompute the digest.
   * Anything the graph holds that the plan did not produce — and vice versa —
   * fails before `VERIFIED` can be reached.
   */
  const verifyReadBack = (plan: SnapshotGraphPlan) =>
    Effect.gen(function* () {
      const fail = (reason: SnapshotGraphVerifyRejected["reason"], detail: string) =>
        Effect.fail(new SnapshotGraphVerifyRejected({ snapshotId: plan.snapshotId, reason, detail }))
      const relationId = (type: string, srcKey: string, dstKey: string): string =>
        JSON.stringify([type, srcKey, dstKey])
      const observedMembers = new Map<string, ObservedVertex>()
      const observedRelations = new Map<string, ObservedRelation>()
      const collectRelation = (path: MemoryPath): void => {
        const source = path.nodes[0]
        const destination = path.nodes[path.nodes.length - 1]
        const relation = path.relationships[0]
        if (source === undefined || destination === undefined || relation === undefined) return
        const srcKey = source.key
        const dstKey = destination.key
        observedRelations.set(relationId(relation.type, srcKey, dstKey), {
          type: relation.type,
          srcKey,
          dstKey,
          properties: relationProperties(relation.properties)
        })
      }

      const rootRow = yield* hydra.resolveNode({
        label: "SnapshotRoot",
        key: plan.root.key,
        properties: Object.keys(plan.root.properties)
      })
      if (Option.isNone(rootRow)) return yield* fail("missingRoot", plan.root.key)
      const observedRoot: ObservedVertex = {
        label: "SnapshotRoot",
        key: plan.root.key,
        properties: vertexProperties(rootRow.value.properties)
      }
      if (canonicalJson(plan.root.properties) !== canonicalJson(observedRoot.properties)) {
        return yield* fail(
          "rootMismatch",
          `${plan.root.key}: expected ${canonicalJson(plan.root.properties)}, observed ${canonicalJson(observedRoot.properties)}`
        )
      }

      const { paths: memberPaths } = yield* hydra.discoverPaths({
        sourceLabel: "SnapshotRoot",
        sourceProperty: KEY_PROPERTY.SnapshotRoot,
        sourceValues: [plan.root.key],
        relTypes: [...MEMBER_RELATION_TYPES],
        relDirection: "outgoing",
        maxLen: 1
      })
      // getById projects only the requested props; the member walk returns the
      // root's full stored property set, which also catches unexpected props.
      let observedRootFull: Record<string, PropertyValue> | undefined
      for (const path of memberPaths) {
        const source = path.nodes[0]
        if (source !== undefined) {
          const props = vertexProperties(source.properties)
          if (observedRootFull === undefined) observedRootFull = props
          else if (canonicalJson(props) !== canonicalJson(observedRootFull)) {
            return yield* fail("rootMismatch", `${plan.root.key}: stored props differ across member paths`)
          }
        }
        const vertex = path.nodes[path.nodes.length - 1]
        if (vertex === undefined) continue
        const key = vertex.key
        const label = vertex.labels[0]
        if (key === "" || label === undefined) continue
        observedMembers.set(JSON.stringify([label, key]), {
          label,
          key,
          properties: vertexProperties(vertex.properties)
        })
        collectRelation(path)
      }
      if (
        observedRootFull !== undefined &&
        canonicalJson(observedRootFull) !== canonicalJson(plan.root.properties)
      ) {
        return yield* fail(
          "rootMismatch",
          `${plan.root.key}: expected ${canonicalJson(plan.root.properties)}, observed ${canonicalJson(observedRootFull)}`
        )
      }
      const digestRoot: ObservedVertex =
        observedRootFull === undefined
          ? observedRoot
          : { label: "SnapshotRoot", key: plan.root.key, properties: observedRootFull }

      // Coverage rule: every snapshot relation touches the root or one of its
      // members, so chunked walks over every SNAPSHOT_* type in both directions
      // observe the whole relation set — a foreign edge on any member fails the
      // diff even when its type or direction is one the plan never writes.
      const collectWalks = (
        label: SnapshotVertexLabel,
        sourceValues: ReadonlyArray<string>,
        relDirection: RelDirection
      ) =>
        Effect.forEach(
          chunksOf(sourceValues, VERIFY_SOURCES_PER_WALK),
          (chunk) =>
            Effect.map(
              hydra.discoverPaths({
                sourceLabel: label,
                sourceProperty: KEY_PROPERTY[label],
                sourceValues: chunk,
                relTypes: [...RELATION_WRITE_ORDER],
                relDirection,
                maxLen: 1
              }),
              ({ paths }) => {
                for (const path of paths) collectRelation(path)
              }
            ),
          { discard: true }
        )
      yield* collectWalks("SnapshotRoot", [plan.root.key], "outgoing")
      for (const label of MEMBER_WRITE_ORDER) {
        const keys = plan.members
          .filter((member) => member.label === label)
          .map((member) => member.key)
        yield* collectWalks(label, keys, "outgoing")
        yield* collectWalks(label, keys, "incoming")
      }

      const expectedMembers = new Map(
        plan.members.map((member) => [JSON.stringify([member.label, member.key]), member])
      )
      for (const [id, observed] of observedMembers) {
        const expected = expectedMembers.get(id)
        if (expected === undefined) {
          return yield* fail("unexpectedMember", `${observed.label} ${observed.key}`)
        }
        if (canonicalJson(expected.properties) !== canonicalJson(observed.properties)) {
          return yield* fail(
            "memberMismatch",
            `${observed.label} ${observed.key}: expected ${canonicalJson(expected.properties)}, observed ${canonicalJson(observed.properties)}`
          )
        }
      }
      for (const [id, expected] of expectedMembers) {
        if (!observedMembers.has(id)) {
          return yield* fail("missingMember", `${expected.label} ${expected.key}`)
        }
      }

      const expectedRelations = new Map(
        plan.relations.map((relation) => [
          relationId(relation.type, relation.srcKey, relation.dstKey),
          relation
        ])
      )
      for (const [id, observed] of observedRelations) {
        const expected = expectedRelations.get(id)
        if (expected === undefined) {
          return yield* fail(
            "unexpectedRelationship",
            `${observed.type} ${observed.srcKey} -> ${observed.dstKey}`
          )
        }
        if (canonicalJson(expected.properties) !== canonicalJson(observed.properties)) {
          return yield* fail(
            "relationshipMismatch",
            `${observed.type} ${observed.srcKey} -> ${observed.dstKey}: expected ${canonicalJson(expected.properties)}, observed ${canonicalJson(observed.properties)}`
          )
        }
      }
      for (const [id, expected] of expectedRelations) {
        if (!observedRelations.has(id)) {
          return yield* fail(
            "missingRelationship",
            `${expected.type} ${expected.srcKey} -> ${expected.dstKey}`
          )
        }
      }

      const observedDigest = snapshotDigest(
        plan.snapshotId,
        [digestRoot, ...[...observedMembers.values()].sort(byVertexOrder)],
        [...observedRelations.values()].sort(byRelationOrder)
      )
      if (observedDigest !== plan.digest) {
        return yield* fail("digestMismatch", `expected ${plan.digest}, observed ${observedDigest}`)
      }
    })

  const build = (
    input: BuildSnapshotGraph
  ): Effect.Effect<UserIndexSnapshotRecord, SnapshotGraphError> =>
    Effect.gen(function* () {
      const record = yield* manifest.readUserIndexSnapshot(input.snapshotId)
      if (record === null) {
        return yield* Effect.fail(new UserIndexSnapshotNotFound({ snapshotId: input.snapshotId }))
      }
      if (record.state === "FAILED") {
        return yield* Effect.fail(
          new SnapshotGraphBuildRejected({
            snapshotId: input.snapshotId,
            reason: "failedState",
            detail: "re-register the snapshot to open a new build attempt"
          })
        )
      }
      const snapshot = record.snapshot
      const scope = snapshot.scope
      const generation = yield* manifest.readIndexGeneration(snapshot.indexGenerationId).pipe(
        Effect.flatMap((stored) =>
          stored === null
            ? Effect.fail(new IndexGenerationNotFound({ generationId: snapshot.indexGenerationId }))
            : Effect.succeed(stored)
        )
      )
      const view = yield* manifest
        .readEntityCanonicalView(
          { tenant: scope.tenantId, uid: scope.uid },
          snapshot.canonicalViewId
        )
        .pipe(
          Effect.flatMap((stored) =>
            stored === null
              ? Effect.fail(
                  new EntityCanonicalViewNotFound({
                    tenant: scope.tenantId,
                    uid: scope.uid,
                    viewId: snapshot.canonicalViewId
                  })
                )
              : Effect.succeed(stored)
          )
        )
      const sources = yield* Effect.forEach(snapshot.sourceCommitIds, (commitId) =>
        gatherSource(scope, snapshot.id, commitId)
      )
      const planned = planSnapshotGraph({
        snapshot,
        generation,
        view,
        sources,
        causalLinks: input.causalLinks
      })
      if (Result.isFailure(planned)) return yield* Effect.fail(planned.failure)
      const plan = planned.success
      if (record.state !== "BUILDING") {
        // Idempotent rebuild: identical content re-derives the stored digest.
        return plan.digest === record.verificationDigest
          ? record
          : yield* Effect.fail(new SnapshotVerificationConflict({ snapshotId: snapshot.id }))
      }
      yield* claimSnapshotGraphPlan(manifest, hydra, plan)
      yield* writePlan(plan)
      const bookmark = Option.getOrUndefined(yield* hydra.lastBookmark)
      yield* hydra.withCausalBookmark(bookmark, verifyReadBack(plan))
      return yield* manifest.verifyUserIndexSnapshot({
        snapshotId: snapshot.id,
        verificationDigest: plan.digest,
        graphRoots: [plan.root.key],
        counts: plan.counts
      })
    })

  return { build } as const
})

export type SnapshotGraph = Effect.Success<typeof make>
const SnapshotGraphTag = Context.Service<SnapshotGraph>("palimpsest/SnapshotGraph")
export const SnapshotGraph = Object.assign(SnapshotGraphTag, {
  layer: Layer.effect(SnapshotGraphTag, make)
})
