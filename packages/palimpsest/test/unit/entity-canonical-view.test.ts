import { Effect, Either } from "effect"
import { describe, expect, it } from "vitest"
import { createEntityCanonicalView, resolveEntityInCanonicalView } from "../../src/EntityCanonicalView.js"
import { IngestManifest, IngestManifestLayerMemory } from "../../src/IngestManifest.js"

describe("EntityCanonicalView", () => {
  it("keeps entity identities immutable while a later SAME_AS view resolves a bridge", () => {
    const identities = [
      { id: "entity-hamster", canon: "hamster", etype: "pet" as const },
      { id: "entity-nibbles", canon: "nibbles", etype: "pet" as const },
      { id: "entity-goldfish", canon: "goldfish", etype: "pet" as const }
    ]
    const beforeBridge = createEntityCanonicalView({ identities, equivalences: [] })
    const afterBridge = createEntityCanonicalView({
      identities,
      equivalences: [{ leftIdentityId: "entity-hamster", rightIdentityId: "entity-nibbles" }]
    })

    expect(Either.isRight(beforeBridge)).toBe(true)
    expect(Either.isRight(afterBridge)).toBe(true)
    if (Either.isLeft(beforeBridge) || Either.isLeft(afterBridge)) return

    expect(beforeBridge.right.sameAs).toEqual([])
    expect(resolveEntityInCanonicalView(beforeBridge.right, "entity-nibbles")).toEqual(
      Either.right("entity-nibbles")
    )
    expect(resolveEntityInCanonicalView(afterBridge.right, "entity-nibbles")).toEqual(
      Either.right("entity-hamster")
    )
    expect(resolveEntityInCanonicalView(afterBridge.right, "entity-goldfish")).toEqual(
      Either.right("entity-goldfish")
    )
    expect(afterBridge.right.sameAs).toEqual([
      {
        fromIdentityId: "entity-nibbles",
        toCanonicalIdentityId: "entity-hamster",
        viewId: afterBridge.right.id
      }
    ])
  })

  it("returns a typed error instead of silently resolving an unknown identity", () => {
    const view = createEntityCanonicalView({
      identities: [{ id: "entity-hamster", canon: "hamster", etype: "pet" }],
      equivalences: []
    })

    expect(Either.isRight(view)).toBe(true)
    if (Either.isLeft(view)) return
    expect(resolveEntityInCanonicalView(view.right, "unknown")).toMatchObject({
      _tag: "Left",
      left: { _tag: "EntityNotInCanonicalView", identityId: "unknown" }
    })
  })

  it("atomically activates and rolls back an immutable canonical view", async () => {
    const identities = [
      { id: "entity-hamster", canon: "hamster", etype: "pet" as const },
      { id: "entity-nibbles", canon: "nibbles", etype: "pet" as const }
    ]
    const original = createEntityCanonicalView({ identities, equivalences: [] })
    const bridged = createEntityCanonicalView({
      identities,
      equivalences: [{ leftIdentityId: "entity-hamster", rightIdentityId: "entity-nibbles" }]
    })
    expect(Either.isRight(original)).toBe(true)
    expect(Either.isRight(bridged)).toBe(true)
    if (Either.isLeft(original) || Either.isLeft(bridged)) return

    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const manifest = yield* IngestManifest
          const scope = { tenant: "default", uid: "user-a" }
          yield* manifest.storeEntityCanonicalView({ ...scope, view: original.right })
          yield* manifest.storeEntityCanonicalView({ ...scope, view: bridged.right })
          yield* manifest.activateEntityCanonicalView({ ...scope, viewId: original.right.id })
          const before = yield* manifest.readActiveEntityCanonicalView(scope)
          yield* manifest.activateEntityCanonicalView({ ...scope, viewId: bridged.right.id })
          const after = yield* manifest.readActiveEntityCanonicalView(scope)
          yield* manifest.activateEntityCanonicalView({ ...scope, viewId: original.right.id })
          const rolledBack = yield* manifest.readActiveEntityCanonicalView(scope)
          return { before, after, rolledBack }
        }).pipe(Effect.provide(IngestManifestLayerMemory))
      )
    )

    expect(outcome.before).not.toBeNull()
    expect(outcome.after).not.toBeNull()
    expect(outcome.rolledBack).not.toBeNull()
    if (outcome.before === null || outcome.after === null || outcome.rolledBack === null) return
    expect(resolveEntityInCanonicalView(outcome.before, "entity-nibbles")).toEqual(
      Either.right("entity-nibbles")
    )
    expect(resolveEntityInCanonicalView(outcome.after, "entity-nibbles")).toEqual(
      Either.right("entity-hamster")
    )
    expect(resolveEntityInCanonicalView(outcome.rolledBack, "entity-nibbles")).toEqual(
      Either.right("entity-nibbles")
    )
  })
})
