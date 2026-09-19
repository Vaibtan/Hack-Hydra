import { edgeId, vertexId, type HydraClient, type HydraError } from "@palimpsest/hydra"
import { Effect } from "effect"
import type { GraphClaimOperations } from "./IngestManifest/GraphClaims.js"
import {
  GraphIdRecoveryRejected,
  type GraphIdCollision,
  type IngestManifestUnavailable,
  type InvalidGraphIdClaim
} from "./IngestManifest.js"
import type { IndexGraphWritePlan } from "./IndexGraph.js"
import type { SnapshotGraphPlan } from "./SnapshotGraph.js"
import type { SourceTranscriptWritePlan } from "./SourceTranscript.js"

export interface GraphWriteRelation {
  readonly type: string
  readonly srcKey: string
  readonly dstKey: string
}

/** The replacement identity that a collision rebuild must write and verify. */
export interface GraphIdRekeyTarget {
  readonly kind: "relationship" | "vertex"
  readonly reducedId: number
  readonly canonicalIdentity: string
}

/**
 * Canonical identity of a relationship claim. This pre-image is exactly what
 * the Hydra write path stores as `__palimpsest_full_key` and reduces with
 * `edgeId`, so the durable claim and the graph write name the same id.
 */
export const relationshipIdentity = (relation: GraphWriteRelation): string =>
  `${relation.srcKey}|${relation.type}|${relation.dstKey}`

export type ClaimWriteIdentitiesError =
  | GraphIdCollision
  | HydraError
  | InvalidGraphIdClaim
  | IngestManifestUnavailable

export type GraphIdentityReader = Pick<HydraClient, "readGraphIdentities">

const claimObservedThenRequested = (
  claims: GraphClaimOperations,
  hydra: GraphIdentityReader,
  input: {
    readonly reducedId: number
    readonly kind: "relationship" | "vertex"
    readonly canonicalIdentity: string
  }
): Effect.Effect<void, ClaimWriteIdentitiesError> =>
  Effect.gen(function* () {
    // S01 upgrade compatibility: an older graph can predate the manifest
    // claim table. Adopt its stored full identity before claiming the new
    // write, so a collision is quarantined instead of overwritten.
    const observed = yield* hydra.readGraphIdentities(input.kind, input.reducedId)
    for (const canonicalIdentity of observed) {
      yield* claims.claimGraphId({ ...input, canonicalIdentity })
    }
    yield* claims.claimGraphId(input)
  })

/**
 * Claim every reduced id a write plan will upsert, before the upsert runs
 * (S01). Retries are safe: re-claiming the same identities is idempotent. A
 * collision quarantines and fails before any ambiguous data is written.
 */
export const claimWriteIdentities = (
  claims: GraphClaimOperations,
  hydra: GraphIdentityReader,
  input: {
    readonly vertices: ReadonlyArray<string>
    readonly relationships: ReadonlyArray<GraphWriteRelation>
  }
): Effect.Effect<void, ClaimWriteIdentitiesError> =>
  Effect.gen(function* () {
    for (const key of input.vertices) {
      yield* claimObservedThenRequested(claims, hydra, {
        reducedId: vertexId(key),
        kind: "vertex",
        canonicalIdentity: key
      })
    }
    for (const relation of input.relationships) {
      const canonicalIdentity = relationshipIdentity(relation)
      yield* claimObservedThenRequested(claims, hydra, {
        reducedId: edgeId(relation.srcKey, relation.type, relation.dstKey),
        kind: "relationship",
        canonicalIdentity
      })
    }
  })

/** All vertex and relationship identities of a source-transcript write plan. */
export const claimSourceTranscriptPlan = (
  claims: GraphClaimOperations,
  hydra: GraphIdentityReader,
  plan: SourceTranscriptWritePlan
): Effect.Effect<void, ClaimWriteIdentitiesError> =>
  claimWriteIdentities(claims, hydra, {
    vertices: [plan.scope.key, plan.session.key, ...plan.turns.map((turn) => turn.key), ...plan.chunks.map((chunk) => chunk.key)],
    relationships: plan.relations.map((relation) => ({
      type: relation.type,
      srcKey: relation.srcKey,
      dstKey: relation.dstKey
    }))
  })

/** All vertex and relationship identities of an index-graph write plan. */
export const claimIndexGraphWritePlan = (
  claims: GraphClaimOperations,
  hydra: GraphIdentityReader,
  plan: IndexGraphWritePlan
): Effect.Effect<void, ClaimWriteIdentitiesError> =>
  claimWriteIdentities(claims, hydra, {
    vertices: [
      ...plan.entities.map((entity) => entity.key),
      ...plan.claims.map((claim) => claim.key),
      ...plan.slots.map((slot) => slot.key),
      ...plan.tokens.map((token) => token.key)
    ],
    relationships: plan.relations.map((relation) => ({
      type: relation.type,
      srcKey: relation.srcKey,
      dstKey: relation.dstKey
    }))
  })

/** All vertex and relationship identities of a snapshot-graph build plan. */
export const claimSnapshotGraphPlan = (
  claims: GraphClaimOperations,
  hydra: GraphIdentityReader,
  plan: SnapshotGraphPlan
): Effect.Effect<void, ClaimWriteIdentitiesError> =>
  claimWriteIdentities(claims, hydra, {
    vertices: [plan.root.key, ...plan.members.map((member) => member.key)],
    relationships: plan.relations.map((relation) => ({
      type: relation.type,
      srcKey: relation.srcKey,
      dstKey: relation.dstKey
    }))
  })

/**
 * Rebuild a rejected graph identity under a changed canonical namespace,
 * verify the stored full identity, and only then resolve its quarantine.
 */
export const recoverGraphIdCollision = <Error, Requirements>(
  claims: GraphClaimOperations,
  hydra: GraphIdentityReader,
  input: {
    readonly reducedId: number
    readonly kind: "relationship" | "vertex"
    readonly rejectedIdentity: string
    readonly replacementCanonicalIdentity: string
    readonly rebuild: (
      target: GraphIdRekeyTarget
    ) => Effect.Effect<void, Error, Requirements>
  }
): Effect.Effect<
  GraphIdRekeyTarget,
  ClaimWriteIdentitiesError | Error | GraphIdRecoveryRejected,
  Requirements
> =>
  Effect.gen(function* () {
    const target: GraphIdRekeyTarget = {
      kind: input.kind,
      reducedId: vertexId(input.replacementCanonicalIdentity),
      canonicalIdentity: input.replacementCanonicalIdentity
    }
    if (target.reducedId === input.reducedId) {
      return yield* Effect.fail(
        new GraphIdRecoveryRejected({
          reducedId: input.reducedId,
          kind: input.kind,
          reason: "sameReducedId"
        })
      )
    }
    yield* claimObservedThenRequested(claims, hydra, target)
    yield* input.rebuild(target)
    const observed = yield* hydra.readGraphIdentities(target.kind, target.reducedId)
    if (observed.length !== 1 || observed[0] !== target.canonicalIdentity) {
      return yield* Effect.fail(
        new GraphIdRecoveryRejected({
          reducedId: input.reducedId,
          kind: input.kind,
          reason: "readBackMismatch"
        })
      )
    }
    yield* claims.completeGraphIdRekey({
      reducedId: input.reducedId,
      kind: input.kind,
      rejectedIdentity: input.rejectedIdentity,
      replacementReducedId: target.reducedId,
      replacementCanonicalIdentity: target.canonicalIdentity
    })
    return target
  })
