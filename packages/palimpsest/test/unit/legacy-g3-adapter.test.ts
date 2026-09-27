import { HydraMemory } from "@palimpsest/hydra"
import { Effect, Layer, Option } from "effect"
import { describe, expect, it } from "vitest"
import {
  LEGACY_G3_REMOVAL_CONDITION,
  LegacyG3Adapter,
  LegacyG3UserNotFound
} from "../../src/LegacyG3Adapter.js"
import { Supersede } from "../../src/Supersede.js"
import { Transcript } from "../../src/Transcript.js"
import { behaviorFake } from "../BehaviorFake.js"

const layer = LegacyG3Adapter.layer.pipe(
  Layer.provideMerge(Layer.succeed(HydraMemory, behaviorFake<HydraMemory>({}))),
  Layer.provideMerge(Layer.succeed(Supersede, behaviorFake<Supersede>({}))),
  Layer.provideMerge(Layer.succeed(Transcript, behaviorFake<Transcript>({})))
)

describe("LegacyG3Adapter telemetry", () => {
  it("counts every legacy operation served, by operation name", async () => {
    const outcome = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const legacy = yield* LegacyG3Adapter
          const before = yield* legacy.telemetry.counts
          yield* legacy.retrieve.forgetUser("user-a")
          yield* legacy.retrieve.forgetUser("user-a")
          return { before, after: yield* legacy.telemetry.counts }
        }),
        layer
      )
    )

    expect(outcome.before).toEqual({})
    expect(outcome.after).toEqual({ "retrieve.forgetUser": 2 })
  })

  it("reads the memoized total lazily so invalidation cannot return a captured stale value", async () => {
    let claims = 5
    const memory = behaviorFake<HydraMemory>({
      resolveNode: () =>
        Effect.sync(() =>
          Option.some({
            id: 1,
            labels: ["User"],
            properties: { n_claims: claims }
          }))
    })
    const testLayer = LegacyG3Adapter.layer.pipe(
      Layer.provideMerge(Layer.succeed(HydraMemory, memory)),
      Layer.provideMerge(Layer.succeed(Supersede, behaviorFake<Supersede>({}))),
      Layer.provideMerge(Layer.succeed(Transcript, behaviorFake<Transcript>({})))
    )

    const observed = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const legacy = yield* LegacyG3Adapter
          expect(yield* legacy.retrieve.totalClaims("user-a")).toBe(5)
          const delayed = legacy.retrieve.totalClaims("user-a")
          claims = 6
          yield* legacy.retrieve.forgetUser("user-a")
          return yield* delayed
        }),
        testLayer
      )
    )

    expect(observed).toBe(6)
  })

  it("returns a typed missing-user failure instead of a defect", async () => {
    const memory = behaviorFake<HydraMemory>({ resolveNode: () => Effect.succeed(Option.none()) })
    const testLayer = LegacyG3Adapter.layer.pipe(
      Layer.provideMerge(Layer.succeed(HydraMemory, memory)),
      Layer.provideMerge(Layer.succeed(Supersede, behaviorFake<Supersede>({}))),
      Layer.provideMerge(Layer.succeed(Transcript, behaviorFake<Transcript>({})))
    )

    const outcome = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const legacy = yield* LegacyG3Adapter
          return yield* Effect.result(legacy.retrieve.totalClaims("missing"))
        }),
        testLayer
      )
    )

    expect(outcome).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "LegacyG3UserNotFound", uid: "missing" }
    })
    expect(outcome._tag === "Failure" && outcome.failure).toBeInstanceOf(LegacyG3UserNotFound)
  })
})

describe("LEGACY_G3_REMOVAL_CONDITION", () => {
  it("names the equivalence gate and the endpoints still to migrate", () => {
    expect(LEGACY_G3_REMOVAL_CONDITION).toContain("S16B")
    expect(LEGACY_G3_REMOVAL_CONDITION).toContain("migration")
  })
})
