import { Effect, Result } from "effect"
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

    expect(Result.isSuccess(beforeBridge)).toBe(true)
    expect(Result.isSuccess(afterBridge)).toBe(true)
    if (Result.isFailure(beforeBridge) || Result.isFailure(afterBridge)) return

    expect(beforeBridge.success.sameAs).toEqual([])
    expect(resolveEntityInCanonicalView(beforeBridge.success, "entity-nibbles")).toEqual(
      Result.succeed("entity-nibbles")
    )
    expect(resolveEntityInCanonicalView(afterBridge.success, "entity-nibbles")).toEqual(
      Result.succeed("entity-hamster")
    )
    expect(resolveEntityInCanonicalView(afterBridge.success, "entity-goldfish")).toEqual(
      Result.succeed("entity-goldfish")
    )
    expect(afterBridge.success.sameAs).toEqual([
      {
        fromIdentityId: "entity-nibbles",
        toCanonicalIdentityId: "entity-hamster",
        viewId: afterBridge.success.id
      }
    ])
  })

  it("returns a typed error instead of silently resolving an unknown identity", () => {
    const view = createEntityCanonicalView({
      identities: [{ id: "entity-hamster", canon: "hamster", etype: "pet" }],
      equivalences: []
    })

    expect(Result.isSuccess(view)).toBe(true)
    if (Result.isFailure(view)) return
    expect(resolveEntityInCanonicalView(view.success, "unknown")).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "EntityNotInCanonicalView", identityId: "unknown" }
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
    expect(Result.isSuccess(original)).toBe(true)
    expect(Result.isSuccess(bridged)).toBe(true)
    if (Result.isFailure(original) || Result.isFailure(bridged)) return

    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const manifest = yield* IngestManifest
          const scope = { tenant: "default", uid: "user-a" }
          yield* manifest.storeEntityCanonicalView({ ...scope, view: original.success })
          yield* manifest.storeEntityCanonicalView({ ...scope, view: bridged.success })
          yield* manifest.activateEntityCanonicalView({ ...scope, viewId: original.success.id })
          const before = yield* manifest.readActiveEntityCanonicalView(scope)
          yield* manifest.activateEntityCanonicalView({ ...scope, viewId: bridged.success.id })
          const after = yield* manifest.readActiveEntityCanonicalView(scope)
          yield* manifest.activateEntityCanonicalView({ ...scope, viewId: original.success.id })
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
      Result.succeed("entity-nibbles")
    )
    expect(resolveEntityInCanonicalView(outcome.after, "entity-nibbles")).toEqual(
      Result.succeed("entity-hamster")
    )
    expect(resolveEntityInCanonicalView(outcome.rolledBack, "entity-nibbles")).toEqual(
      Result.succeed("entity-nibbles")
    )
  })
})
