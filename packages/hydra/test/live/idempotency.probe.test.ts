import { NodeHttpClient } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { HydraClient, vertexId } from "../../src/index.js"

const UID = "probe-idem"

const layer = HydraClient.Default.pipe(Layer.provide(NodeHttpClient.layerUndici))

const run = <A, E>(effect: Effect.Effect<A, E, HydraClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, layer) as Effect.Effect<A, E, never>)

const vertex = (n: number) => ({
  key: `${UID}|v|${n}`,
  properties: { vkey: `${UID}|v|${n}`, uid: UID, n }
})

describe("write request ids", () => {
  it("honours a client-supplied request id, and conflicts when one is reused", async () => {
    const post = async (body: unknown): Promise<{ status: number; json: any }> => {
      const response = await fetch("http://127.0.0.1:8443/v1/graphs/default/query", {
        method: "POST",
        headers: {
          Authorization: "Bearer local-development-token-32-bytes",
          "X-Graph-Namespace": "default",
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      })
      return { status: response.status, json: await response.json() }
    }

    await run(
      Effect.gen(function* () {
        const hydra = yield* HydraClient
        return yield* hydra.batchMerge("ProbeIdem", [vertex(1), vertex(2)])
      })
    )

    const rel = (src: number, dst: number, queryId: string) => ({
      cell_id: "cell-0",
      query_id: queryId,
      query:
        "UNWIND $rows AS row MATCH (s:ProbeIdem {id: row.s}), (d:ProbeIdem {id: row.d}) " +
        "MERGE (s)-[r:PROBE_IDEM {id: row.r}]->(d)",
      parameters: {
        rows: [
          {
            s: vertexId(`${UID}|v|${src}`),
            d: vertexId(`${UID}|v|${dst}`),
            r: vertexId(`${UID}|rel|${src}-${dst}`)
          }
        ]
      }
    })

    const fixed = `probe-idem-fixed-${process.pid}`
    const first = await post(rel(1, 2, fixed))
    expect(first.status).toBeLessThan(400)
    expect(first.json.query_id).toBe(fixed)

    const conflict = await post(rel(2, 1, fixed))
    expect(conflict.status).toBeGreaterThanOrEqual(400)

    const fresh = await post(rel(2, 1, `${fixed}-b`))
    expect(fresh.status).toBeLessThan(400)
  })

  it("never collides across statements, because every statement gets a fresh id", async () => {
    const written = await run(
      Effect.gen(function* () {
        const hydra = yield* HydraClient
        yield* hydra.batchMerge("ProbeIdem", [vertex(10), vertex(11), vertex(12)])
        yield* hydra.batchRel("PROBE_IDEM", [
          { srcLabel: "ProbeIdem", srcKey: `${UID}|v|10`, dstLabel: "ProbeIdem", dstKey: `${UID}|v|11` }
        ])
        yield* hydra.batchRel("PROBE_IDEM", [
          { srcLabel: "ProbeIdem", srcKey: `${UID}|v|11`, dstLabel: "ProbeIdem", dstKey: `${UID}|v|12` }
        ])
        return yield* hydra.msPaths({
          sourceLabel: "ProbeIdem",
          sourceProperty: "vkey",
          sourceValues: [`${UID}|v|10`],
          relTypes: ["PROBE_IDEM"],
          relDirection: "outgoing",
          maxLen: 2
        })
      })
    )
    expect(written.length).toBeGreaterThan(0)
  })

  it("re-running the identical write is still a no-op", async () => {
    const [first, second] = await run(
      Effect.gen(function* () {
        const hydra = yield* HydraClient
        const rows = [vertex(20), vertex(21)]
        const a = yield* hydra.batchMerge("ProbeIdem", rows)
        const b = yield* hydra.batchMerge("ProbeIdem", rows)
        const count = yield* hydra.query(
          "MATCH (n:ProbeIdem) WHERE n.uid = $uid AND n.n >= 20 AND n.n <= 21 RETURN count(*) AS c",
          { uid: UID }
        )
        return [a + b, Number(count.rows[0]?.["c"] ?? 0)] as const
      })
    )
    expect(first).toBe(4)
    expect(second).toBe(2)
  })
})
