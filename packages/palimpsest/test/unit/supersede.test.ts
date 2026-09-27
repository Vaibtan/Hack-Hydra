import { NodeHttpClient } from "@effect/platform-node"
import { HydraMemoryLive, type MemoryPath } from "@palimpsest/hydra"
import { Llm } from "@palimpsest/llm"
import { Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Supersede, foldSupersessionEdges, type SlotClaim } from "../../src/Supersede.js"
import { behaviorFake, runWithBehaviorFakes } from "../BehaviorFake.js"

const claim = (ckey: string, sessionOrd: number, text: string, tEvent = 0): SlotClaim => ({
  ckey,
  text,
  sessionOrd,
  tEvent,
  sid: `s${sessionOrd}`
})

const stubLlm = (
  replacements: ReadonlyArray<{ older: number; newer: number; reason: string }>,
  calls: Array<string>
) =>
  Layer.succeed(Llm, behaviorFake<Llm>({
    model: "stub",
    cacheDir: "",
    concurrency: 1,
    generateObject: (options: { prompt: string; schema: Schema.Top }) =>
      Effect.sync(() => {
        calls.push(options.prompt)
        return { value: { replacements }, cached: false }
      }),
    usage: Effect.succeed({ inputTokens: 0, outputTokens: 0, calls: 0, cacheHits: 0 }),
    resetUsage: Effect.void
  }))

const layerWith = (
  replacements: ReadonlyArray<{ older: number; newer: number; reason: string }>,
  calls: Array<string>
) =>
  Supersede.layer.pipe(
    Layer.provide(stubLlm(replacements, calls)),
    Layer.provideMerge(HydraMemoryLive),
    Layer.provide(NodeHttpClient.layerUndici)
  )

const detect = (
  claims: ReadonlyArray<SlotClaim>,
  replacements: ReadonlyArray<{ older: number; newer: number; reason: string }>,
  calls: Array<string> = []
) =>
  runWithBehaviorFakes(
    Effect.provide(
      Effect.gen(function* () {
        const supersede = yield* Supersede
        return yield* supersede.detect("me", "residence", claims)
      }),
      layerWith(replacements, calls)
    )
  )

const nyc = claim("c1", 2, "The user lives in NYC.")
const brooklyn = claim("c2", 5, "The user moved to Brooklyn.")
const sf = claim("c3", 9, "The user moved to San Francisco.")

describe("Supersede.detect", () => {
  it("stamps at_session with the newer claim's session, not the older's", async () => {
    const result = await detect([nyc, brooklyn, sf], [
      { older: 1, newer: 2, reason: "moved" },
      { older: 2, newer: 3, reason: "moved again" }
    ])
    expect(result.edges).toEqual([
      { olderCkey: "c1", newerCkey: "c2", atSession: 5 },
      { olderCkey: "c2", newerCkey: "c3", atSession: 9 }
    ])
  })

  it("refuses a pair that points backwards in the slot's history", async () => {
    const result = await detect([nyc, brooklyn], [{ older: 2, newer: 1, reason: "slip" }])
    expect(result.edges).toEqual([])
  })

  it("ignores a claim a self-link, a duplicate pair, and an out-of-range index", async () => {
    const result = await detect([nyc, brooklyn], [
      { older: 1, newer: 1, reason: "self" },
      { older: 1, newer: 2, reason: "ok" },
      { older: 1, newer: 2, reason: "same again" },
      { older: 1, newer: 9, reason: "no such claim" }
    ])
    expect(result.edges).toEqual([{ olderCkey: "c1", newerCkey: "c2", atSession: 5 }])
  })

  it("does not ask the model about a slot holding a single claim", async () => {
    const calls: Array<string> = []
    const result = await detect([nyc], [{ older: 1, newer: 2, reason: "x" }], calls)
    expect(result.edges).toEqual([])
    expect(calls).toEqual([])
  })

  it("keeps two claims in the same session, which is a real tie, not a slip", async () => {
    const a = claim("c1", 4, "The user weighs 80 kg.")
    const b = claim("c2", 4, "The user now weighs 78 kg.")
    const result = await detect([a, b], [{ older: 1, newer: 2, reason: "corrected" }])
    expect(result.edges).toEqual([{ olderCkey: "c1", newerCkey: "c2", atSession: 4 }])
  })

  it("shows the model the claims in order, numbered, with their sessions", async () => {
    const calls: Array<string> = []
    await detect([nyc, brooklyn, sf], [], calls)
    const prompt = calls[0]!
    expect(prompt).toContain("me | residence")
    expect(prompt.indexOf("1. (session 2)")).toBeLessThan(prompt.indexOf("2. (session 5)"))
    expect(prompt).toContain("3. (session 9)")
    expect(prompt).not.toContain("|c|")
  })
})

describe("foldSupersessionEdges", () => {
  const edge = (older: string, newer: string, atSession: number): MemoryPath => ({
    nodes: [
      { id: 1, key: older, labels: ["Claim"], properties: { ckey: older } },
      { id: 2, key: newer, labels: ["Claim"], properties: { ckey: newer } }
    ],
    relationships: [
      { id: 3, key: `${older}|SUPERSEDED_BY|${newer}`, type: "SUPERSEDED_BY", src: 1, dst: 2, properties: { at_session: atSession } }
    ]
  })

  it("labels a claim with what replaced it", () => {
    const folded = foldSupersessionEdges([edge("c1", "c2", 7)])
    expect(folded.get("c1")).toEqual({ newer: "c2", atSession: 7 })
  })

  it("keeps the earliest replacement when one claim has two outgoing edges", () => {
    const forward = foldSupersessionEdges([edge("c1", "c3", 30), edge("c1", "c2", 7)])
    const reversed = foldSupersessionEdges([edge("c1", "c2", 7), edge("c1", "c3", 30)])
    expect(forward.get("c1")).toEqual({ newer: "c2", atSession: 7 })
    expect(reversed).toEqual(forward)
  })

  it("breaks a same-session tie by claim key rather than by path order", () => {
    const forward = foldSupersessionEdges([edge("c1", "cb", 7), edge("c1", "ca", 7)])
    const reversed = foldSupersessionEdges([edge("c1", "ca", 7), edge("c1", "cb", 7)])
    expect(forward.get("c1")?.newer).toBe("ca")
    expect(reversed).toEqual(forward)
  })

  it("ignores an edge written after the as-of session", () => {
    expect(foldSupersessionEdges([edge("c1", "c2", 37)], 4).size).toBe(0)
    expect(foldSupersessionEdges([edge("c1", "c2", 3)], 4).get("c1")?.newer).toBe("c2")
  })
})
