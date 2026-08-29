import { createHash } from "node:crypto"
import { Data, Either } from "effect"
import { canonicalJson } from "./SourceIdentity.js"
import type { ExtractedEntity } from "./Extract.js"

/** An immutable physical Entity identity that a canonical view may resolve. */
export interface EntityIdentity {
  /** Stable physical identity; a view never rewrites it. */
  readonly id: string
  /** Canonical text recorded when this immutable identity was indexed. */
  readonly canon: string
  /** Entity category recorded with the immutable identity. */
  readonly etype: ExtractedEntity["etype"]
}

/** A proposed equivalence between two immutable Entity identities. */
export interface EntityEquivalence {
  readonly leftIdentityId: string
  readonly rightIdentityId: string
}

/** Input used to create one selected canonical view. */
export interface CreateEntityCanonicalView {
  readonly identities: ReadonlyArray<EntityIdentity>
  readonly equivalences: ReadonlyArray<EntityEquivalence>
}

/** An immutable, direct SAME_AS edge in one canonical view. */
export interface SameAsEdge {
  readonly viewId: string
  readonly fromIdentityId: string
  readonly toCanonicalIdentityId: string
}

/** A deterministic, versioned view over immutable Entity identities. */
export interface EntityCanonicalView {
  /** Content-addressed identity of this exact resolution view. */
  readonly id: string
  /** Direct resolution for every identity represented by the view. */
  readonly resolutions: ReadonlyMap<string, string>
  /** Non-identity resolutions persisted as versioned SAME_AS edges. */
  readonly sameAs: ReadonlyArray<SameAsEdge>
}

/** The supplied identities or equivalences cannot form a canonical view. */
export class InvalidEntityCanonicalView extends Data.TaggedError("InvalidEntityCanonicalView")<{
  readonly reason: "emptyIdentity" | "duplicateIdentity" | "unknownIdentity" | "invalidEncoding"
  readonly identityId: string
}> {
  override get message(): string {
    return `Invalid entity canonical view: ${this.reason} for ${this.identityId}`
  }
}

/** An identity is not represented by the selected canonical view. */
export class EntityNotInCanonicalView extends Data.TaggedError("EntityNotInCanonicalView")<{
  readonly identityId: string
}> {
  override get message(): string {
    return `Entity identity ${this.identityId} is not represented by the canonical view`
  }
}

class IdentityGroups {
  private readonly parent = new Map<string, string>()

  add(identityId: string): void {
    this.parent.set(identityId, identityId)
  }

  find(identityId: string): string {
    const initial = this.parent.get(identityId)
    if (initial === undefined) throw new Error(`unknown identity ${identityId}`)
    let root = initial
    while (true) {
      const next = this.parent.get(root)
      if (next === undefined) throw new Error(`group parent missing for ${root}`)
      if (next === root) break
      root = next
    }

    let current = identityId
    while (current !== root) {
      const next = this.parent.get(current)
      if (next === undefined) throw new Error(`group parent missing for ${current}`)
      this.parent.set(current, root)
      current = next
    }
    return root
  }

  union(leftIdentityId: string, rightIdentityId: string): void {
    const left = this.find(leftIdentityId)
    const right = this.find(rightIdentityId)
    if (left === right) return
    this.parent.set(right, left)
  }
}

const compareIdentity = (left: EntityIdentity, right: EntityIdentity): number => {
  const canon = left.canon.localeCompare(right.canon)
  return canon === 0 ? left.id.localeCompare(right.id) : canon
}

const hash = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex")

const descriptorFor = (resolutions: ReadonlyMap<string, string>): string =>
  canonicalJson({
    format: "palimpsest.entity-canonical-view.v1",
    resolutions: [...resolutions.entries()].sort(([left], [right]) => left.localeCompare(right))
  })

const viewFromResolutions = (resolutions: ReadonlyMap<string, string>): EntityCanonicalView => {
  const id = `canonical-view-v1-${hash(descriptorFor(resolutions))}`
  const sameAs = [...resolutions.entries()]
    .filter(([identityId, canonicalIdentityId]) => identityId !== canonicalIdentityId)
    .map(([fromIdentityId, toCanonicalIdentityId]) => ({ viewId: id, fromIdentityId, toCanonicalIdentityId }))
    .sort((left, right) => left.fromIdentityId.localeCompare(right.fromIdentityId))
  return { id, resolutions, sameAs }
}

/**
 * Creates a content-addressed canonical view without changing a physical Entity
 * identity. The lexically first `(canon, id)` in each equivalence component is
 * the view's canonical target, so every rebuild of the same input is stable.
 */
export const createEntityCanonicalView = (
  input: CreateEntityCanonicalView
): Either.Either<EntityCanonicalView, InvalidEntityCanonicalView> => {
  const identitiesById = new Map<string, EntityIdentity>()
  const groups = new IdentityGroups()
  for (const identity of input.identities) {
    if (identity.id.trim().length === 0 || identity.canon.trim().length === 0) {
      return Either.left(new InvalidEntityCanonicalView({ reason: "emptyIdentity", identityId: identity.id }))
    }
    if (identitiesById.has(identity.id)) {
      return Either.left(new InvalidEntityCanonicalView({ reason: "duplicateIdentity", identityId: identity.id }))
    }
    identitiesById.set(identity.id, identity)
    groups.add(identity.id)
  }
  for (const equivalence of input.equivalences) {
    if (!identitiesById.has(equivalence.leftIdentityId)) {
      return Either.left(
        new InvalidEntityCanonicalView({
          reason: "unknownIdentity",
          identityId: equivalence.leftIdentityId
        })
      )
    }
    if (!identitiesById.has(equivalence.rightIdentityId)) {
      return Either.left(
        new InvalidEntityCanonicalView({
          reason: "unknownIdentity",
          identityId: equivalence.rightIdentityId
        })
      )
    }
    groups.union(equivalence.leftIdentityId, equivalence.rightIdentityId)
  }

  const components = new Map<string, Array<EntityIdentity>>()
  for (const identity of identitiesById.values()) {
    const root = groups.find(identity.id)
    const component = components.get(root)
    if (component === undefined) components.set(root, [identity])
    else component.push(identity)
  }

  const resolutions = new Map<string, string>()
  for (const component of components.values()) {
    const canonical = [...component].sort(compareIdentity)[0]
    if (canonical === undefined) throw new Error("canonical view component was empty")
    for (const identity of component) resolutions.set(identity.id, canonical.id)
  }
  return Either.right(viewFromResolutions(resolutions))
}

/** Serializes the content that determines one canonical-view identity. */
export const serializeEntityCanonicalView = (view: EntityCanonicalView): string => descriptorFor(view.resolutions)

/** Parses a persisted canonical view and verifies its content-addressed identity. */
export const parseEntityCanonicalView = (
  id: string,
  serialized: string
): Either.Either<EntityCanonicalView, InvalidEntityCanonicalView> => {
  try {
    const parsed = JSON.parse(serialized) as { readonly format?: unknown; readonly resolutions?: unknown }
    if (parsed.format !== "palimpsest.entity-canonical-view.v1" || !Array.isArray(parsed.resolutions)) {
      return Either.left(new InvalidEntityCanonicalView({ reason: "invalidEncoding", identityId: id }))
    }
    const resolutions = new Map<string, string>()
    for (const pair of parsed.resolutions) {
      if (
        !Array.isArray(pair) ||
        pair.length !== 2 ||
        typeof pair[0] !== "string" ||
        typeof pair[1] !== "string" ||
        pair[0].trim().length === 0 ||
        pair[1].trim().length === 0 ||
        resolutions.has(pair[0])
      ) {
        return Either.left(new InvalidEntityCanonicalView({ reason: "invalidEncoding", identityId: id }))
      }
      resolutions.set(pair[0], pair[1])
    }
    const view = viewFromResolutions(resolutions)
    return view.id === id
      ? Either.right(view)
      : Either.left(new InvalidEntityCanonicalView({ reason: "invalidEncoding", identityId: id }))
  } catch {
    return Either.left(new InvalidEntityCanonicalView({ reason: "invalidEncoding", identityId: id }))
  }
}

/** Resolves one immutable identity through the selected canonical view. */
export const resolveEntityInCanonicalView = (
  view: EntityCanonicalView,
  identityId: string
): Either.Either<string, EntityNotInCanonicalView> => {
  const canonicalIdentityId = view.resolutions.get(identityId)
  return canonicalIdentityId === undefined
    ? Either.left(new EntityNotInCanonicalView({ identityId }))
    : Either.right(canonicalIdentityId)
}
