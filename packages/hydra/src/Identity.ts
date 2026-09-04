import { Effect, Either } from "effect"
import { FULL_KEY_PROPERTY } from "./Cypher.js"
import type { HydraPath } from "./Decode.js"
import type { HydraIdentityIntegrityError } from "./Errors.js"
import {
  createGraphIdentityRegistry,
  verifyStoredGraphIdentity,
  type GraphIdentityRegistry
} from "./Ids.js"

export type IdentityOutcome = Either.Either<void, HydraIdentityIntegrityError>

export const identityEffect = <A>(
  outcome: Either.Either<A, HydraIdentityIntegrityError>
): Effect.Effect<A, HydraIdentityIntegrityError> =>
  outcome._tag === "Left" ? Effect.fail(outcome.left) : Effect.succeed(outcome.right)

/** The client's own id read back off the wire; `NaN` (a mismatch) when absent. */
export const contentAddressedId = (properties: Readonly<Record<string, unknown>>): number =>
  typeof properties["id"] === "number" ? properties["id"] : Number.NaN

const storedFullKey = (properties: Readonly<Record<string, unknown>>): string | null =>
  typeof properties[FULL_KEY_PROPERTY] === "string" ? properties[FULL_KEY_PROPERTY] : null

export interface Identity {
  readonly registry: GraphIdentityRegistry
  /** Claims the numeric id for a vertex key in the process-local registry. */
  readonly claimVertexId: (key: string) => Either.Either<number, HydraIdentityIntegrityError>
  readonly claimRelationshipId: (key: string) => Either.Either<number, HydraIdentityIntegrityError>
  readonly verifyPath: (path: HydraPath) => IdentityOutcome
  readonly verifyVertexRow: (
    key: string,
    numericId: number,
    row: Readonly<Record<string, unknown>>
  ) => IdentityOutcome
}

/** The write-path guard is process-local; the persisted full key is verified on every read. */
export const makeIdentity = (registry: GraphIdentityRegistry = createGraphIdentityRegistry()): Identity => {
  const claimVertexId = (key: string) =>
    Either.map(registry.claimVertex(key), (identity) => identity.numericId)
  const claimRelationshipId = (key: string) =>
    Either.map(registry.claimRelationship(key), (identity) => identity.numericId)

  const verifyPath = (path: HydraPath): IdentityOutcome => {
    for (const node of path.nodes) {
      const storedKey = storedFullKey(node.properties)
      if (storedKey !== null) {
        const claimed = registry.claimVertex(storedKey)
        if (claimed._tag === "Left") return Either.left(claimed.left)
      }
      const verified = verifyStoredGraphIdentity({
        kind: "vertex",
        numericId: node.id,
        requestedKey: storedKey ?? "",
        storedKey
      })
      if (verified._tag === "Left") return Either.left(verified.left)
    }
    for (const relationship of path.relationships) {
      const storedKey = storedFullKey(relationship.properties)
      if (storedKey !== null) {
        const claimed = registry.claimRelationship(storedKey)
        if (claimed._tag === "Left") return Either.left(claimed.left)
      }
      const verified = verifyStoredGraphIdentity({
        kind: "relationship",
        numericId: contentAddressedId(relationship.properties),
        requestedKey: storedKey ?? "",
        storedKey
      })
      if (verified._tag === "Left") return Either.left(verified.left)
    }
    return Either.void
  }

  const verifyVertexRow = (
    key: string,
    numericId: number,
    row: Readonly<Record<string, unknown>>
  ): IdentityOutcome =>
    verifyStoredGraphIdentity({ kind: "vertex", numericId, requestedKey: key, storedKey: storedFullKey(row) })

  return { registry, claimVertexId, claimRelationshipId, verifyPath, verifyVertexRow }
}
