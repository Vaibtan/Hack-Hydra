import { NodeHttpClient } from "@effect/platform-node"
import { datasetPath, loadQuestion } from "@palimpsest/dataset"
import { HydraClient } from "@palimpsest/hydra"
import { LlmLive } from "@palimpsest/llm"
import { Effect, Layer } from "effect"
import { existsSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { ClaimGraph } from "../../src/ClaimGraph.js"
import { Ingest } from "../../src/Ingest.js"
import { Supersede } from "../../src/Supersede.js"
import { Transcript } from "../../src/Transcript.js"

const hasDataset = existsSync(datasetPath("s"))

const AppLive = Ingest.Default.pipe(
  Layer.provideMerge(Transcript.Default),
  Layer.provideMerge(ClaimGraph.Default),
  Layer.provideMerge(Supersede.Default),
  Layer.provideMerge(HydraClient.Default),
  Layer.provideMerge(LlmLive()),
  Layer.provide(NodeHttpClient.layerUndici)
)

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(Effect.provide(effect, AppLive) as unknown as Effect.Effect<A, E, never>)

const UID = "probe-supersede"
const SOURCE = "852ce960"

describe.skipIf(!hasDataset)("supersession pass", () => {
  it("builds a chain on the answering slot and leaves additive facts alone", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const ingest = yield* Ingest
        const supersede = yield* Supersede
        const claimGraph = yield* ClaimGraph
        const question = yield* loadQuestion("s", SOURCE).pipe(Effect.orDie)

        const first = yield* ingest.ingestUser(UID, question)
        const contested = yield* supersede.contestedSlots(UID)
        const chains = yield* Effect.forEach(contested, (slot) =>
          supersede.chain(UID, slot.skey).pipe(Effect.map((claims) => ({ slot, claims })))
        )
        const again = yield* supersede.run(UID, contested)
        const after = yield* claimGraph.stats(UID)
        return { first, again, after, chains }
      })
    )

    const { first, again, after, chains } = outcome

    expect(first.supersessions.edges).toBeGreaterThan(0)
    expect(first.stats.contestedSlots).toBeGreaterThan(0)

    const mortgage = chains.find(({ slot }) => slot.entityName === "mortgage" && slot.attr === "price")
    expect(mortgage).toBeDefined()
    expect(mortgage!.claims.length).toBeGreaterThanOrEqual(2)

    const superseded = mortgage!.claims.filter((claim) => claim.supersededBy !== null)
    const current = mortgage!.claims.filter((claim) => claim.supersededBy === null)
    expect(superseded.length).toBeGreaterThan(0)
    expect(current.length).toBeGreaterThan(0)

    const newest = [...mortgage!.claims].sort((a, b) => b.sessionOrd - a.sessionOrd)[0]!
    expect(newest.supersededBy).toBeNull()

    const bySessionOrd = new Map(mortgage!.claims.map((claim) => [claim.ckey, claim.sessionOrd]))
    for (const claim of superseded) {
      const newerOrd = bySessionOrd.get(claim.supersededBy!)
      if (newerOrd !== undefined) expect(newerOrd).toBeGreaterThanOrEqual(claim.sessionOrd)
      expect(claim.atSession).toBe(newerOrd ?? claim.atSession)
    }

    const untouched = chains.filter(
      ({ claims }) => claims.length >= 2 && claims.every((claim) => claim.supersededBy === null)
    )
    expect(untouched.length).toBeGreaterThan(0)

    expect(again.edges).toBe(first.supersessions.edges)
    expect(after.supersessions).toBe(first.stats.supersessions)
    expect(again.cachedDecisions).toBe(again.slotsContested)
  })

  it("replays the chain as of an earlier session", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const supersede = yield* Supersede
        const contested = yield* supersede.contestedSlots(UID)
        const slot = contested.find((s) => s.entityName === "mortgage" && s.attr === "price")!
        const now = yield* supersede.chain(UID, slot.skey)
        const before = yield* supersede.chain(UID, slot.skey, 4)
        return { now, before }
      })
    )

    expect(outcome.before.length).toBeLessThan(outcome.now.length)
    expect(outcome.before.every((claim) => claim.sessionOrd <= 4)).toBe(true)
    expect(outcome.before.every((claim) => claim.supersededBy === null)).toBe(true)
    expect(outcome.now.some((claim) => claim.supersededBy !== null)).toBe(true)
  })
})
