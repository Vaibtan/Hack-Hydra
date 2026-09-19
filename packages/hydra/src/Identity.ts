import { Effect, Result, Schema } from "effect"
import { FULL_KEY_PROPERTY } from "./Cypher.js"
import type { HydraPath, Row, Scalar } from "./Decode.js"
import type { HydraIdentityIntegrityError } from "./Errors.js"
import {
  createGraphIdentityRegistry,
  verifyStoredGraphIdentity,
  type GraphIdentityRegistry
} from "./Ids.js"

export type IdentityOutcome = Result.Result<void, HydraIdentityIntegrityError>

export const identityEffect = <A>(
  outcome: Result.Result<A, HydraIdentityIntegrityError>
): Effect.Effect<A, HydraIdentityIntegrityError> =>
  outcome._tag === "Failure" ? Effect.fail(outcome.failure) : Effect.succeed(outcome.success)

/** The client's own id read back off the wire; `NaN` (a mismatch) when absent. */
export const contentAddressedId = (properties: Readonly<Record<string, Scalar>>): number => {
  const id = properties["id"]
  return Schema.is(Schema.Number)(id) ? id : Number.NaN
}

const storedFullKey = (properties: Readonly<Record<string, Scalar>> | Row): string | null => {
  const stored = properties[FULL_KEY_PROPERTY]
  return Schema.is(Schema.String)(stored) ? stored : null
}

export interface Identity {
  readonly registry: GraphIdentityRegistry
  readonly claimVertexId: (key: string) => Result.Result<number, HydraIdentityIntegrityError>
  readonly claimRelationshipId: (key: string) => Result.Result<number, HydraIdentityIntegrityError>
  readonly verifyPath: (path: HydraPath) => IdentityOutcome
  readonly verifyVertexRow: (
    key: string,
    numericId: number,
    row: Row
  ) => IdentityOutcome
}

export const createIdentity = (registry: GraphIdentityRegistry = createGraphIdentityRegistry()): Identity => {
  const claimVertexId = (key: string) =>
    Result.map(registry.claimVertex(key), (identity) => identity.numericId)
  const claimRelationshipId = (key: string) =>
    Result.map(registry.claimRelationship(key), (identity) => identity.numericId)

  const verifyPath = (path: HydraPath): IdentityOutcome => {
    for (const node of path.nodes) {
      const storedKey = storedFullKey(node.properties)
      if (storedKey !== null) {
        const claimed = registry.claimVertex(storedKey)
        if (claimed._tag === "Failure") return Result.fail(claimed.failure)
      }
      const verified = verifyStoredGraphIdentity({
        kind: "vertex",
        numericId: node.id,
        requestedKey: storedKey ?? "",
        storedKey
      })
      if (verified._tag === "Failure") return Result.fail(verified.failure)
    }
    for (const relationship of path.relationships) {
      const storedKey = storedFullKey(relationship.properties)
      if (storedKey !== null) {
        const claimed = registry.claimRelationship(storedKey)
        if (claimed._tag === "Failure") return Result.fail(claimed.failure)
      }
      const verified = verifyStoredGraphIdentity({
        kind: "relationship",
        numericId: contentAddressedId(relationship.properties),
        requestedKey: storedKey ?? "",
        storedKey
      })
      if (verified._tag === "Failure") return Result.fail(verified.failure)
    }
    return Result.void
  }

  const verifyVertexRow = (
    key: string,
    numericId: number,
    row: Row
  ): IdentityOutcome =>
    verifyStoredGraphIdentity({ kind: "vertex", numericId, requestedKey: key, storedKey: storedFullKey(row) })

  return { registry, claimVertexId, claimRelationshipId, verifyPath, verifyVertexRow }
}
