import { HydraClient, HydraUnavailable, type HydraPath } from "@palimpsest/hydra"
import { Effect, Layer, Option } from "effect"
import { describe, expect, it } from "vitest"
import { WARM_SOURCES_PER_WALK, warmUser } from "../../src/User.js"
import { behaviorFake, runWithBehaviorFakes } from "../BehaviorFake.js"

const node = (property: string, key: string) => ({
  id: 1,
  labels: [],
  properties: { [property]: key }
})

const path = (
  sourceProperty: string,
  source: string,
  targetProperty: string,
  target: string
): HydraPath =>
  behaviorFake<HydraPath>({
    nodes: [node(sourceProperty, source), node(targetProperty, target)],
    relationships: [{ id: 1, type: "REL", src: 1, dst: 1, properties: {} }]
  })

interface Call {
  readonly relType: string
  readonly sources: number
}

const stubHydra = (
  options: {
    readonly entities: number
    readonly slots: number
    readonly sessions: number
    readonly answer: (relType: string, sources: ReadonlyArray<string>) => "fail" | number
    readonly perCallMs?: number
    readonly calls: Array<Call>
    readonly now: { value: number }
  }
) =>
  Layer.succeed(HydraClient, behaviorFake<HydraClient>({
    getById: (label: string, key: string) =>
      Effect.succeed(
        Option.some({
          ukey: key,
          claims: 10,
          entities: options.entities,
          slots: options.slots,
          tokens: 0,
          sessions: options.sessions,
          turns: 0,
          supersessions: 0,
          contested_slots: 0,
          n_claims: 10,
          n_entities: options.entities,
          n_slots: options.slots,
          n_tokens: 0,
          n_sessions: options.sessions,
          n_turns: 0,
          n_supersessions: 0,
          n_contested_slots: 0,
          label
        })
      ),
    msPaths: (config: {
      readonly relTypes: ReadonlyArray<string>
      readonly sourceValues: ReadonlyArray<string>
      readonly sourceProperty: string
    }) =>
      Effect.suspend(() => {
        const relType = config.relTypes[0]!
        options.now.value += options.perCallMs ?? 0
        if (relType === "HAS_ENTITY" || relType === "HAS_SLOT" || relType === "HAS_SESSION") {
          const count =
            relType === "HAS_ENTITY"
              ? options.entities
              : relType === "HAS_SLOT"
                ? options.slots
                : options.sessions
          const property =
            relType === "HAS_ENTITY" ? "ekey" : relType === "HAS_SLOT" ? "skey" : "sess"
          return Effect.succeed(
            Array.from({ length: count }, (_, i) =>
              path("ukey", "u|user", property, `u|${property}|${i}`)
            )
          )
        }
        options.calls.push({ relType, sources: config.sourceValues.length })
        const answered = options.answer(relType, config.sourceValues)
        if (answered === "fail") {
          return Effect.fail(new HydraUnavailable({ reason: "engine refused" }))
        }
        const target =
          relType === "NAMES" ? "tkey" : relType === "FILLS" ? "ckey" : relType === "HITS" ? "ckey" : "turn"
        return Effect.succeed(
          Array.from({ length: answered }, (_, i) =>
            path(config.sourceProperty, config.sourceValues[0]!, target, `u|${target}|${i}`)
          )
        )
      })
  }))

const warm = (
  options: Parameters<typeof stubHydra>[0],
  warmOptions: Parameters<typeof warmUser>[2] = {}
) =>
  runWithBehaviorFakes(
    Effect.provide(
      Effect.gen(function* () {
        const hydra = yield* HydraClient
        return yield* warmUser(hydra, "u", warmOptions)
      }),
      stubHydra(options)
    )
  )

describe("source keys are chunked", () => {
  it("never sends more than one walk's worth of keys", async () => {
    const calls: Array<Call> = []
    await warm({
      entities: 2292,
      slots: 3,
      sessions: 2,
      answer: () => 1,
      calls,
      now: { value: 0 }
    })

    expect(calls.every((call) => call.sources <= WARM_SOURCES_PER_WALK)).toBe(true)
    const names = calls.filter((call) => call.relType === "NAMES")
    expect(names).toHaveLength(Math.ceil(2292 / WARM_SOURCES_PER_WALK))
  })

  it("makes one walk when the keys fit in one", async () => {
    const calls: Array<Call> = []
    await warm({ entities: 5, slots: 0, sessions: 0, answer: () => 1, calls, now: { value: 0 } })

    expect(calls.filter((call) => call.relType === "NAMES")).toHaveLength(1)
  })

  it("makes no walk at all when a level has no keys", async () => {
    const calls: Array<Call> = []
    await warm({ entities: 0, slots: 0, sessions: 0, answer: () => 1, calls, now: { value: 0 } })

    expect(calls).toEqual([])
  })
})

describe("a failed walk is counted, never swallowed", () => {
  it("reports the failure rather than an empty result", async () => {
    const report = await warm({
      entities: 10,
      slots: 0,
      sessions: 0,
      answer: (relType) => (relType === "NAMES" ? "fail" : 1),
      calls: [],
      now: { value: 0 }
    })

    expect(Option.isSome(report)).toBe(true)
    const it = Option.getOrThrow(report)
    expect(it.failed).toBe(1)
    expect(it.tokens).toBe(0)
  })

  it("carries on to the other levels after one fails", async () => {
    const report = Option.getOrThrow(
      await warm({
        entities: 10,
        slots: 10,
        sessions: 10,
        answer: (relType) => (relType === "NAMES" ? "fail" : 4),
        calls: [],
        now: { value: 0 }
      })
    )

    expect(report.failed).toBe(1)
    expect(report.slotClaims).toBe(4)
    expect(report.turns).toBe(4)
  })
})

describe("the budget", () => {
  it("stops and says it stopped", async () => {
    const now = { value: 0 }
    const report = Option.getOrThrow(
      await warm(
        { entities: 4000, slots: 0, sessions: 0, answer: () => 1, perCallMs: 0, calls: [], now },
        { budgetMs: -1 }
      )
    )

    expect(report.truncated).toBe(true)
  })

  it("does not claim truncation when everything fit", async () => {
    const report = Option.getOrThrow(
      await warm({ entities: 5, slots: 5, sessions: 5, answer: () => 1, calls: [], now: { value: 0 } })
    )

    expect(report.truncated).toBe(false)
    expect(report.failed).toBe(0)
  })
})
