import { NodeHttpClient } from "@effect/platform-node"
import { datasetPath, loadQuestion } from "@palimpsest/dataset"
import { HydraMemory, HydraMemoryLive } from "@palimpsest/hydra"
import { LlmLive } from "@palimpsest/llm"
import { Effect, Layer } from "effect"
import { existsSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { ClaimGraph } from "../../src/ClaimGraph.js"
import { Ingest } from "../../src/Ingest.js"
import { claimKind, tokenKey } from "../../src/Keys.js"
import { Supersede } from "../../src/Supersede.js"
import { stems } from "../../src/Tokenize.js"
import { Transcript } from "../../src/Transcript.js"
import { readUserStats } from "../../src/User.js"

const hasOracle = existsSync(datasetPath("oracle"))

const AppLive = Ingest.layer.pipe(
  Layer.provideMerge(Transcript.layer),
  Layer.provideMerge(ClaimGraph.layer),
  Layer.provideMerge(Supersede.layer),
  Layer.provideMerge(HydraMemoryLive),
  Layer.provideMerge(LlmLive()),
  Layer.provide(NodeHttpClient.layerUndici)
)

const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof AppLive>>) =>
  Effect.runPromise(Effect.provide(effect, AppLive))

const UID = "probe-claimgraph-g2"
const SOURCE = "gpt4_2655b836"

describe.skipIf(!hasOracle)("claim graph writes", () => {
  it("writes a complete, self-consistent graph and re-ingest changes nothing", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const ingest = yield* Ingest
        const claimGraph = yield* ClaimGraph
        const supersede = yield* Supersede
        const hydra = yield* HydraMemory
        const question = yield* loadQuestion("oracle", SOURCE).pipe(Effect.orDie)

        const first = yield* ingest.ingestUser(UID, question)
        const second = yield* ingest.ingestUser(UID, question)

        const entities = yield* claimGraph.readEntities(UID)
        const candidates = [
          ...new Set(entities.flatMap((entity) => stems(entity.canon)))
        ].slice(0, 24)
        const dfMap = yield* claimGraph.readTokenDf(UID, candidates)
        const topDf = [...dfMap]
          .filter(([, df]) => df > 0)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([stem, df]) => ({ stem, df }))
        const dfChecks = yield* Effect.forEach(topDf, (row) =>
          hydra
            .discoverPaths({
              sourceLabel: "Token",
              sourceProperty: "tkey",
              sourceValues: [tokenKey(UID, String(row["stem"]))],
              targetLabel: "Claim",
              targetProperty: "kind",
              targetValues: [claimKind(UID)],
              relTypes: ["HITS"],
              relDirection: "outgoing",
              maxLen: 1
            })
            .pipe(
              Effect.map(({ paths }) => ({
                stem: String(row["stem"]),
                stored: Number(row["df"]),
                actual: new Set(
                  paths.map((path) => path.nodes[path.nodes.length - 1]!.properties["ckey"])
                ).size
              }))
            )
        )

        const contested = yield* supersede.contestedSlots(UID)
        const slotClaims = yield* supersede.readSlotClaims(
          UID,
          contested.slice(0, 4).map((slot: { readonly skey: string }) => slot.skey)
        )
        const sampleClaim = [...slotClaims.values()].flat().sort((a, b) =>
          a.ckey.localeCompare(b.ckey)
        )[0]!
        const ckey = sampleClaim.ckey
        const anchors = [...new Set(stems(sampleClaim.text))].slice(0, 6)
        const { paths } = yield* hydra.discoverPaths({
          sourceLabel: "Token",
          sourceProperty: "tkey",
          sourceValues: anchors.map((stem) => tokenKey(UID, stem)),
          targetLabel: "Claim",
          targetProperty: "kind",
          targetValues: [claimKind(UID)],
          relTypes: ["HITS", "NAMES", "MENTIONS"],
          relDirection: "outgoing",
          maxLen: 2
        })

        const { paths: evidencePaths } = yield* hydra.discoverPaths({
          sourceLabel: "Claim",
          sourceProperty: "ckey",
          sourceValues: [ckey],
          relTypes: ["EVIDENCE"],
          relDirection: "outgoing",
          maxLen: 1
        })
        const stats = yield* claimGraph.stats(UID)
        return { question, first, second, dfChecks, paths, ckey, evidencePaths, stats }
      })
    )

    const { question, first, second, dfChecks, paths, ckey, evidencePaths, stats } = outcome

    expect(stats.claims).toBeGreaterThan(50)
    expect(stats.sessions).toBe(question.sessions.length)
    expect(stats.entities).toBeGreaterThan(0)
    expect(stats.slots).toBeGreaterThan(0)
    expect(stats.tokens).toBeGreaterThan(0)
    expect(stats.contestedSlots).toBeGreaterThan(0)

    expect(second.stats).toEqual(first.stats)
    expect(second.sessions.every((s) => s.cached)).toBe(true)

    expect(dfChecks.length).toBeGreaterThan(0)
    for (const check of dfChecks) expect(check.stored).toBe(check.actual)

    const reached = new Set(
      paths.map((path) => path.nodes[path.nodes.length - 1]!.properties["ckey"])
    )
    expect(reached.has(ckey)).toBe(true)

    const evidencePath = evidencePaths[0]!
    const turn = evidencePath.nodes[evidencePath.nodes.length - 1]!
    const edge = evidencePath.relationships[0]!
    const text = String(turn.properties["text"] ?? "")
    const cs = Number(edge.properties["cs"])
    const ce = Number(edge.properties["ce"])
    expect(ce).toBeGreaterThan(cs)
    expect(ce).toBeLessThanOrEqual(text.length)
  })

  it("keeps a second user's graph entirely separate", async () => {
    const counts = await run(
      Effect.gen(function* () {
        const hydra = yield* HydraMemory
        const mine = yield* readUserStats(hydra, UID)
        const theirs = yield* readUserStats(hydra, "no-such-user")
        return [
          mine._tag === "Some" ? mine.value.claims : 0,
          theirs._tag === "Some" ? theirs.value.claims : 0
        ] as const
      })
    )
    expect(counts[0]).toBeGreaterThan(0)
    expect(counts[1]).toBe(0)
  })
})
