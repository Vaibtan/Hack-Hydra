import { NodeHttpClient } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { beforeAll, describe, expect, it } from "vitest"
import { HydraClient, vertexId } from "../../src/index.js"

/**
 * The label-scan wall.
 *
 * HydraDB indexes a vertex by `{id: …}` and the source values `algo.MSpaths`
 * is driven from. It indexes **nothing else** — `MATCH (n:Label) WHERE n.prop
 * = $value` reads every vertex carrying that label in the *whole store*, at
 * roughly 100 µs each, no matter how few of them belong to the user asking.
 *
 * That is the same failure shape as the 1024-row wall in `paging.probe`:
 * invisible while the graph is small, and then total. Measured on the working
 * graph, one user's Claim count cost **4.4 s** at 58 k Claims and one Token
 * count **9.5 s**, against **~0.1 s** for a read by id — and a per-user read at
 * the 500-user scale would sit past the engine's 30 s cap. Eleven reads on the
 * product path were this shape; the `User` vertex and its `HAS_*` edges exist
 * to make every one of them a by-id read or an `MSpaths` hop.
 *
 * This probe pins the fact so it cannot quietly stop being true.
 */
const UID = "probe-byid"
const ROWS = 50_000

const layer = HydraClient.Default.pipe(Layer.provide(NodeHttpClient.layerUndici))

const run = <A, E>(effect: Effect.Effect<A, E, HydraClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, layer) as Effect.Effect<A, E, never>)

const keys = Array.from({ length: ROWS }, (_, i) => `${UID}|s|${String(i).padStart(6, "0")}`)
const target = keys[ROWS - 1]!

beforeAll(() =>
  run(
    Effect.gen(function* () {
      const hydra = yield* HydraClient
      // Fixed keys: a re-run overwrites rather than accumulates, so the probe
      // never needs a delete — which this engine cannot do anyway.
      yield* hydra.batchMerge(
        "ProbeScan",
        keys.map((key, i) => ({ key, properties: { skey: key, uid: UID, n: i } }))
      )
    })
  )
)

const timed = async <A>(effect: Effect.Effect<A, unknown, HydraClient>): Promise<[A, number]> => {
  const started = Date.now()
  const value = await run(effect as Effect.Effect<A, never, HydraClient>)
  return [value, Date.now() - started]
}

describe("id-keyed reads versus label scans", () => {
  it("resolves one vertex by id an order of magnitude faster than by property", async () => {
    const byId = Effect.gen(function* () {
      const hydra = yield* HydraClient
      return yield* hydra.getById("ProbeScan", target, ["skey", "n"])
    })
    const byProperty = Effect.gen(function* () {
      const hydra = yield* HydraClient
      return yield* hydra.query(
        "MATCH (n:ProbeScan) WHERE n.skey = $skey RETURN n.skey AS skey, n.n AS n",
        { skey: target }
      )
    })

    // Interleaved, best of three, after a warm-up on both sides: a first touch
    // pays HydraDB's page cache, and the live suite is noisy enough that
    // measuring one path and then the other would compare different weather.
    // The gap this is about survives being warm — that is the point of it.
    await run(byId)
    await run(byProperty)
    let bestById = Number.POSITIVE_INFINITY
    let bestScan = Number.POSITIVE_INFINITY
    let idResult = await run(byId)
    let scanResult = await run(byProperty)
    for (let attempt = 0; attempt < 3; attempt++) {
      const [id, idMs] = await timed(byId)
      const [scan, scanMs] = await timed(byProperty)
      idResult = id
      scanResult = scan
      bestById = Math.min(bestById, idMs)
      bestScan = Math.min(bestScan, scanMs)
    }

    // Same vertex, same properties — only the access path differs.
    expect(idResult._tag).toBe("Some")
    expect(idResult._tag === "Some" ? Number(idResult.value["n"]) : -1).toBe(ROWS - 1)
    expect(scanResult.rows).toHaveLength(1)

    console.log(
      `      by id ${bestById} ms · label scan over ${ROWS} vertices ${bestScan} ms · ` +
        `${(bestScan / Math.max(1, bestById)).toFixed(1)}x`
    )
    expect(bestScan).toBeGreaterThan(bestById * 10)
  })

  it("costs the same by id whether the vertex is the first or the last written", async () => {
    // Best of three, because a first touch pays the engine's page cache and
    // this test is about the access path, not about cache state.
    const best = async (key: string): Promise<number> => {
      let fastest = Number.POSITIVE_INFINITY
      for (let attempt = 0; attempt < 3; attempt++) {
        const [, ms] = await timed(
          Effect.gen(function* () {
            const hydra = yield* HydraClient
            return yield* hydra.getById("ProbeScan", key, ["skey"])
          })
        )
        fastest = Math.min(fastest, ms)
      }
      return fastest
    }

    const firstMs = await best(keys[0]!)
    const lastMs = await best(target)
    // A scan would make position matter by 20 000 vertices' worth. An index
    // does not: both land in the same tens of milliseconds.
    console.log(`      first written ${firstMs} ms · last written ${lastMs} ms`)
    expect(firstMs).toBeLessThan(500)
    expect(lastMs).toBeLessThan(500)
  })

  it("has no batched by-id read: many vertices at once must go through MSpaths", async () => {
    // Recording the two shapes that look obvious and are both refused, so the
    // next person does not rediscover them. `UNWIND` is a write form here.
    const unwind = await run(
      Effect.gen(function* () {
        const hydra = yield* HydraClient
        return yield* hydra
          .query(
            "UNWIND $rows AS row MATCH (n:ProbeScan {id: row.id}) RETURN n.skey AS skey",
            // `Params` is scalar-only by design: the batch write forms are the
            // only callers that pass a row list, so this probe goes around the
            // type to record what the read form answers.
            { rows: [{ id: vertexId(target) }] } as never
          )
          .pipe(Effect.flip)
      })
    )
    expect(unwind.reason).toMatch(/UNWIND batch supports one-hop relationships only/)

    const inList = await run(
      Effect.gen(function* () {
        const hydra = yield* HydraClient
        return yield* hydra
          .query("MATCH (n:ProbeScan) WHERE n.id IN [1, 2] RETURN n.skey AS skey")
          .pipe(Effect.flip)
      })
    )
    expect(inList.reason).toMatch(/boolean combinations of property comparisons/)
  })
})
