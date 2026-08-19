import { NodeHttpClient } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { HydraClient } from "../../src/index.js"

/**
 * The 1024-row wall.
 *
 * HydraDB returns at most 1024 rows per response and hands back a
 * `next_cursor` when there are more. Ignoring it does not fail — it silently
 * truncates, which for a retrieval system means recall quietly capped with no
 * error anywhere. `algo.MSpaths` is subject to the same wall and cannot take
 * `SKIP`/`LIMIT`, so following the cursor is the only way to see all of it.
 *
 * Continuing a result needs **both** the cursor and the originating `query_id`:
 * the cursor alone answers `result cursor does not belong to this query
 * request` or returns nothing at all.
 */
const UID = "probe-paging"
const ROWS = 2_600

const layer = HydraClient.Default.pipe(Layer.provide(NodeHttpClient.layerUndici))

const run = <A, E>(effect: Effect.Effect<A, E, HydraClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, layer) as Effect.Effect<A, E, never>)

const keys = Array.from({ length: ROWS }, (_, i) => `${UID}|p|${String(i).padStart(5, "0")}`)

beforeAll(() =>
  run(
    Effect.gen(function* () {
      const hydra = yield* HydraClient
      // Fixed keys, so a re-run overwrites rather than accumulates and the
      // suite never has to pay for a delete.
      yield* hydra.batchMerge("ProbePage", [
        { key: `${UID}|hub`, properties: { pkey: `${UID}|hub`, uid: UID, n: -1 } },
        ...keys.map((key, i) => ({ key, properties: { pkey: key, uid: UID, n: i } }))
      ])
      yield* hydra.batchRel(
        "PAGES_TO",
        keys.map((key) => ({
          srcLabel: "ProbePage",
          srcKey: `${UID}|hub`,
          dstLabel: "ProbePage",
          dstKey: key
        }))
      )
    })
  )
)

afterAll(() => Promise.resolve())

describe("result paging", () => {
  it("returns every row of a read larger than one page", async () => {
    const rows = await run(
      Effect.gen(function* () {
        const hydra = yield* HydraClient
        const result = yield* hydra.query(
          "MATCH (n:ProbePage) WHERE n.uid = $uid AND n.n >= 0 RETURN n.pkey AS pkey",
          { uid: UID }
        )
        return result.rows
      })
    )
    expect(rows).toHaveLength(ROWS)
    // No duplicates: pages must not overlap.
    expect(new Set(rows.map((row) => String(row["pkey"]))).size).toBe(ROWS)
  })

  it("returns every path of an MSpaths result larger than one page", async () => {
    const paths = await run(
      Effect.gen(function* () {
        const hydra = yield* HydraClient
        return yield* hydra.msPaths({
          sourceLabel: "ProbePage",
          sourceProperty: "pkey",
          sourceValues: [`${UID}|hub`],
          targetLabel: "ProbePage",
          targetProperty: "uid",
          targetValues: [UID],
          relTypes: ["PAGES_TO"],
          relDirection: "outgoing",
          maxLen: 1,
          pathCount: 10_000
        })
      })
    )
    // Without cursor following this would stop at exactly 1024.
    expect(paths.length).toBeGreaterThan(1024)
    expect(paths.length).toBe(ROWS)
  })
})
