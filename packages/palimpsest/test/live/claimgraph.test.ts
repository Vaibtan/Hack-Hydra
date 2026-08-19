import { NodeHttpClient } from "@effect/platform-node"
import { datasetPath, loadQuestion } from "@palimpsest/dataset"
import { HydraClient } from "@palimpsest/hydra"
import { LlmLive } from "@palimpsest/llm"
import { Effect, Layer } from "effect"
import { existsSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { ClaimGraph, Ingest, Supersede, Transcript, claimKind, stems, tokenKey } from "../../src/index.js"

/**
 * A whole user through the whole write path, against the live node and the real
 * model. The properties asserted here are the ones #6's retrieval will assume:
 * that a claim is reachable from its own anchors in two hops, that `df` is a
 * real document frequency, and that re-ingesting changes nothing.
 */
const hasOracle = existsSync(datasetPath("oracle"))

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

/**
 * The uid carries a generation suffix. The graph is additive and deletes are
 * impractical on this engine, so changing the extraction prompt leaves the old
 * claims in place beside the new ones — which makes `Token.df` (counted for the
 * current generation) disagree with the edges actually present. Ingesting under
 * a fresh key prefix is the cheap, supported way to get a clean graph; bump the
 * suffix whenever the extraction prompt changes.
 */
const UID = "probe-claimgraph-g2"
const SOURCE = "gpt4_2655b836"

// Nothing is wiped between runs. Every write is content-addressed, so a second
// ingest of the same user reproduces the same graph exactly — which is the
// property under test — and `DETACH DELETE` of a whole user is an hours-long
// operation on this engine, not a test fixture.

describe.skipIf(!hasOracle)("claim graph writes", () => {
  it("writes a complete, self-consistent graph and re-ingest changes nothing", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const ingest = yield* Ingest
        const claimGraph = yield* ClaimGraph
        const hydra = yield* HydraClient
        const question = yield* loadQuestion("oracle", SOURCE).pipe(Effect.orDie)

        const first = yield* ingest.ingestUser(UID, question)
        const second = yield* ingest.ingestUser(UID, question)

        // df, checked against the graph rather than against what we wrote.
        const dfRows = yield* hydra.query(
          "MATCH (t:Token) WHERE t.uid = $uid RETURN t.stem AS stem, t.df AS df ORDER BY df DESC LIMIT 5",
          { uid: UID }
        )
        // Counted with MSpaths rather than `MATCH (t)-[:HITS]->(c) … count(*)`:
        // that join is evaluated against the whole store, not the matched
        // subset, so it exceeds the engine's 30 s cap once a few users share
        // the graph. MSpaths is driven from the source values and stays fast.
        const dfChecks = yield* Effect.forEach(dfRows.rows, (row) =>
          hydra
            .msPaths({
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
              Effect.map((paths) => ({
                stem: String(row["stem"]),
                stored: Number(row["df"]),
                actual: new Set(
                  paths.map((path) => path.nodes[path.nodes.length - 1]!.properties["ckey"])
                ).size
              }))
            )
        )

        // One claim, and the anchors it was written with: MSpaths must reach it.
        const sample = yield* hydra.query(
          "MATCH (c:Claim) WHERE c.uid = $uid RETURN c.ckey AS ckey, c.text AS text ORDER BY ckey LIMIT 1",
          { uid: UID }
        )
        const ckey = String(sample.rows[0]!["ckey"])
        const anchors = [...new Set(stems(String(sample.rows[0]!["text"])))].slice(0, 6)
        const paths = yield* hydra.msPaths({
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

        const evidence = yield* hydra.query(
          "MATCH (c:Claim)-[r:EVIDENCE]->(t:Turn) WHERE c.ckey = $ckey RETURN t.text AS text, r.cs AS cs, r.ce AS ce",
          { ckey }
        )
        const stats = yield* claimGraph.stats(UID)
        return { question, first, second, dfChecks, paths, ckey, evidence, stats }
      })
    )

    const { question, first, second, dfChecks, paths, ckey, evidence, stats } = outcome

    expect(stats.claims).toBeGreaterThan(50)
    expect(stats.sessions).toBe(question.sessions.length)
    expect(stats.entities).toBeGreaterThan(0)
    expect(stats.slots).toBeGreaterThan(0)
    expect(stats.tokens).toBeGreaterThan(0)
    // Supersession can only ever fire where a slot holds more than one claim.
    expect(stats.contestedSlots).toBeGreaterThan(0)

    // Idempotent: identical counts, and the second pass hit the LLM cache.
    expect(second.stats).toEqual(first.stats)
    expect(second.sessions.every((s) => s.cached)).toBe(true)

    // Token.df is a real document frequency.
    expect(dfChecks.length).toBeGreaterThan(0)
    for (const check of dfChecks) expect(check.stored).toBe(check.actual)

    // The claim is reachable from its own anchors — the retrieval mechanism.
    const reached = new Set(
      paths.map((path) => path.nodes[path.nodes.length - 1]!.properties["ckey"])
    )
    expect(reached.has(ckey)).toBe(true)

    // EVIDENCE points at a real Span in a real Turn.
    const row = evidence.rows[0]!
    const text = String(row["text"])
    expect(Number(row["ce"])).toBeGreaterThan(Number(row["cs"]))
    expect(Number(row["ce"])).toBeLessThanOrEqual(text.length)
  })

  it("keeps a second user's graph entirely separate", async () => {
    const counts = await run(
      Effect.gen(function* () {
        const hydra = yield* HydraClient
        const mine = yield* hydra.query(
          "MATCH (c:Claim) WHERE c.uid = $uid RETURN count(*) AS c",
          { uid: UID }
        )
        const theirs = yield* hydra.query(
          "MATCH (c:Claim) WHERE c.kind = $kind RETURN count(*) AS c",
          { kind: claimKind("no-such-user") }
        )
        return [Number(mine.rows[0]!["c"]), Number(theirs.rows[0]!["c"])] as const
      })
    )
    expect(counts[0]).toBeGreaterThan(0)
    expect(counts[1]).toBe(0)
  })
})
