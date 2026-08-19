import { NodeHttpClient } from "@effect/platform-node"
import { Effect, Layer, Option } from "effect"
import { beforeAll, describe, expect, it } from "vitest"
import { HydraClient, HydraParseError, vertexId } from "../../src/index.js"

/**
 * The probe suite. Every test here encodes a HydraDB behaviour the Palimpsest
 * design leans on (see `docs/review-2026-08-17-palimpsest-plan.md` §7). They run
 * against the live Docker node, because a mock would only re-state our beliefs.
 *
 * All keys are namespaced under a probe uid so the suite never collides with
 * ingested data in the shared `default` graph.
 */
const UID = "probe-hydra-1"
const k = (suffix: string) => `${UID}|${suffix}`

const layer = HydraClient.Default.pipe(Layer.provide(NodeHttpClient.layerUndici))

const run = <A, E>(effect: Effect.Effect<A, E, HydraClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, layer) as Effect.Effect<A, E, never>)

const CLAIM_KIND = k("claim")

const tokenKeys = [k("t|cat"), k("t|vet"), k("t|hamster")]
const entityKey = k("e|cat")
const claimKeys = [k("c|1"), k("c|2"), k("c|3")]

/**
 * Nothing is deleted, before or after. Every key here is fixed, so a re-run
 * overwrites the same vertices — and on a graph of any size `DETACH DELETE` is
 * first slow and then outright rejected (`delete_vertex_scan_edges … exceeds
 * limit 1000000`), because the scan is proportional to the whole store.
 */
const seed = Effect.gen(function* () {
  const hydra = yield* HydraClient
  yield* hydra.batchMerge(
    "Token",
    tokenKeys.map((key, i) => ({ key, properties: { tkey: key, uid: UID, df: i + 1 } }))
  )
  yield* hydra.batchMerge("Entity", [
    { key: entityKey, properties: { ekey: entityKey, uid: UID, name: "cat" } }
  ])
  yield* hydra.batchMerge(
    "Claim",
    claimKeys.map((key, i) => ({
      key,
      properties: {
        ckey: key,
        kind: CLAIM_KIND,
        uid: UID,
        text: `claim ${i + 1}`,
        session_ord: i + 1,
        session_date: 20230101 + i
      }
    }))
  )
  // cat -> c1, cat -> c2 ; vet -> c1 ; cat NAMES entity(cat) MENTIONS c3
  yield* hydra.batchRel("HITS", [
    { srcLabel: "Token", srcKey: tokenKeys[0]!, dstLabel: "Claim", dstKey: claimKeys[0]! },
    { srcLabel: "Token", srcKey: tokenKeys[0]!, dstLabel: "Claim", dstKey: claimKeys[1]! },
    { srcLabel: "Token", srcKey: tokenKeys[1]!, dstLabel: "Claim", dstKey: claimKeys[0]! }
  ])
  yield* hydra.batchRel("NAMES", [
    { srcLabel: "Token", srcKey: tokenKeys[0]!, dstLabel: "Entity", dstKey: entityKey }
  ])
  yield* hydra.batchRel("MENTIONS", [
    { srcLabel: "Entity", srcKey: entityKey, dstLabel: "Claim", dstKey: claimKeys[2]! }
  ])
  yield* hydra.batchRel("SUPERSEDED_BY", [
    {
      srcLabel: "Claim",
      srcKey: claimKeys[0]!,
      dstLabel: "Claim",
      dstKey: claimKeys[1]!,
      properties: { at_session: 2 }
    }
  ])
})

beforeAll(() => run(seed))

const convergenceQuery = (values: ReadonlyArray<string>, maxLen: number) => ({
  sourceLabel: "Token",
  sourceProperty: "tkey",
  sourceValues: values,
  targetLabel: "Claim",
  targetProperty: "kind",
  targetValues: [CLAIM_KIND],
  relTypes: ["HITS", "NAMES", "MENTIONS"] as const,
  relDirection: "outgoing" as const,
  maxLen
})

describe("HydraClient against the live node", () => {
  it("round-trips a batched vertex upsert and reads the properties back", async () => {
    const rows = await run(
      Effect.gen(function* () {
        const hydra = yield* HydraClient
        const result = yield* hydra.query(
          "MATCH (n:Claim) WHERE n.uid = $uid RETURN n.ckey AS ckey, n.session_ord AS ord ORDER BY ord",
          { uid: UID }
        )
        return result.rows
      })
    )
    expect(rows).toEqual([
      { ckey: claimKeys[0], ord: 1 },
      { ckey: claimKeys[1], ord: 2 },
      { ckey: claimKeys[2], ord: 3 }
    ])
  })

  it("is idempotent: re-running the same batch changes nothing", async () => {
    const count = () =>
      run(
        Effect.gen(function* () {
          const hydra = yield* HydraClient
          const result = yield* hydra.query(
            "MATCH (n:Claim) WHERE n.uid = $uid RETURN count(*) AS c",
            { uid: UID }
          )
          return result.rows[0]!["c"]
        })
      )
    const before = await count()
    await run(seed)
    expect(await count()).toBe(before)
  })

  it("chunks a batch larger than the 1 MB body cap transparently", async () => {
    // 150 x 8 KB is ~1.2 MB of body, over the cap. The keys are fixed, so a
    // re-run overwrites the same vertices instead of adding more — which is why
    // nothing is deleted afterwards: `DETACH DELETE` is far slower than the
    // write (see the constants in Client.ts) and the test does not need it.
    const bulkKeys = Array.from({ length: 150 }, (_, i) => k(`bulk|${i}`))
    const padding = "x".repeat(8_000)
    const outcome = await run(
      Effect.gen(function* () {
        const hydra = yield* HydraClient
        const written = yield* hydra.batchMerge(
          "ProbeBulk",
          bulkKeys.map((key) => ({ key, properties: { bkey: key, uid: UID, text: padding } }))
        )
        // Read one row back by key rather than counting the label: the count is
        // graph-wide and this suite deliberately leaves its vertices behind.
        const readBack = yield* hydra.query(
          "MATCH (n:ProbeBulk) WHERE n.bkey = $bkey RETURN n.text AS text",
          { bkey: bulkKeys[bulkKeys.length - 1]! }
        )
        return { written, text: String(readBack.rows[0]?.["text"] ?? "") }
      })
    )
    // Only passes if the client split the batch: a single statement carrying
    // all 150 rows would be refused for exceeding the 1 MB body cap.
    expect(outcome.written).toBe(150)
    expect(outcome.text).toBe(padding)
  })

  it("MSpaths with a constant-property target selector returns every source->claim pair", async () => {
    const paths = await run(
      Effect.gen(function* () {
        const hydra = yield* HydraClient
        return yield* hydra.msPaths(convergenceQuery([tokenKeys[0]!, tokenKeys[1]!], 2))
      })
    )
    const reached = paths.map((p) => {
      const first = p.nodes[0]!
      const last = p.nodes[p.nodes.length - 1]!
      return `${first.properties["tkey"]}->${last.properties["ckey"]}`
    })
    expect(reached.sort()).toEqual(
      [
        `${tokenKeys[0]}->${claimKeys[0]}`,
        `${tokenKeys[0]}->${claimKeys[1]}`,
        `${tokenKeys[0]}->${claimKeys[2]}`,
        `${tokenKeys[1]}->${claimKeys[0]}`
      ].sort()
    )
  })

  it("caps a source-only walk at pathCount per source — the client raises it by default", async () => {
    const [engineDefault, clientDefault] = await run(
      Effect.gen(function* () {
        const hydra = yield* HydraClient
        const base = {
          sourceLabel: "Token",
          sourceProperty: "tkey",
          sourceValues: [tokenKeys[0]!],
          relTypes: ["HITS", "NAMES", "MENTIONS"],
          relDirection: "outgoing" as const,
          maxLen: 2
        }
        // `pathCount: 1` is what the engine does when the key is omitted, and
        // it reports no truncation of any kind: this is a recall cap that looks
        // exactly like an answer. Walking the `User` root over `HAS_SESSION`
        // returned 1 of 39 sessions before the client started always sending
        // the ceiling.
        const a = yield* hydra.msPaths({ ...base, pathCount: 1 })
        const b = yield* hydra.msPaths(base)
        return [a, b] as const
      })
    )
    expect(engineDefault).toHaveLength(1)
    expect(clientDefault.length).toBeGreaterThan(1)
  })

  it("silently skips unknown anchors and returns no rows when all are unknown", async () => {
    const [mixed, allUnknown] = await run(
      Effect.gen(function* () {
        const hydra = yield* HydraClient
        const a = yield* hydra.msPaths(convergenceQuery([tokenKeys[1]!, k("t|no-such-token")], 2))
        const b = yield* hydra.msPaths(convergenceQuery([k("t|nope-a"), k("t|nope-b")], 2))
        return [a, b] as const
      })
    )
    expect(mixed.length).toBeGreaterThan(0)
    expect(allUnknown).toEqual([])
  })

  it("reaches a claim only through the Entity hop when maxLen allows two hops", async () => {
    const [oneHop, twoHop] = await run(
      Effect.gen(function* () {
        const hydra = yield* HydraClient
        const a = yield* hydra.msPaths(convergenceQuery([tokenKeys[0]!], 1))
        const b = yield* hydra.msPaths(convergenceQuery([tokenKeys[0]!], 2))
        return [a, b] as const
      })
    )
    const ckeys = (paths: typeof oneHop) =>
      paths.map((p) => p.nodes[p.nodes.length - 1]!.properties["ckey"]).sort()
    expect(ckeys(oneHop)).not.toContain(claimKeys[2])
    expect(ckeys(twoHop)).toContain(claimKeys[2])
  })

  it("filters on a relationship property, which is how as-of reads are pushed down", async () => {
    // Anchored on the source vertex's id rather than `WHERE a.uid = $uid`: the
    // uid form is a store-wide join over every SUPERSEDED_BY edge and exceeds
    // the 30 s cap once real data shares the graph. What is being probed is
    // that the *edge property* filter works, and that needs one claim.
    const rows = await run(
      Effect.gen(function* () {
        const hydra = yield* HydraClient
        const older = vertexId(claimKeys[0]!)
        const now = yield* hydra.query(
          "MATCH (a:Claim {id: $id})-[r:SUPERSEDED_BY]->(b:Claim) WHERE r.at_session <= $k " +
            "RETURN a.ckey AS older, b.ckey AS newer",
          { id: older, k: 2 }
        )
        const before = yield* hydra.query(
          "MATCH (a:Claim {id: $id})-[r:SUPERSEDED_BY]->(b:Claim) WHERE r.at_session <= $k " +
            "RETURN a.ckey AS older, b.ckey AS newer",
          { id: older, k: 1 }
        )
        return [now.rows, before.rows] as const
      })
    )
    expect(rows[0]).toEqual([{ older: claimKeys[0], newer: claimKeys[1] }])
    // The edge is stamped at session 2, so as of session 1 it is not visible.
    expect(rows[1]).toEqual([])
  })

  it("supports STARTS WITH on a parameter, the prefix fallback for anchors", async () => {
    const rows = await run(
      Effect.gen(function* () {
        const hydra = yield* HydraClient
        const result = yield* hydra.query(
          "MATCH (n:Token) WHERE n.tkey STARTS WITH $prefix RETURN n.tkey AS tkey ORDER BY tkey",
          { prefix: `${UID}|t|` }
        )
        return result.rows
      })
    )
    expect(rows.map((r) => r["tkey"]).sort()).toEqual([...tokenKeys].sort())
  })

  it("surfaces the engine's own reason text as a typed parse error", async () => {
    const failure = await run(
      Effect.gen(function* () {
        const hydra = yield* HydraClient
        return yield* Effect.flip(hydra.query("MATCH (n:Claim) RETURN *"))
      })
    )
    expect(failure).toBeInstanceOf(HydraParseError)
    expect((failure as HydraParseError).reason).toContain("RETURN * is not executable")
  })

  it("threads the last write's bookmark into the next read", async () => {
    const bookmark = await run(
      Effect.gen(function* () {
        const hydra = yield* HydraClient
        yield* hydra.batchMerge("Token", [
          { key: tokenKeys[2]!, properties: { tkey: tokenKeys[2]!, uid: UID, df: 7 } }
        ])
        return yield* hydra.lastBookmark
      })
    )
    expect(Option.isSome(bookmark)).toBe(true)
  })

  it("derives vertex ids that the engine actually stores", async () => {
    const rows = await run(
      Effect.gen(function* () {
        const hydra = yield* HydraClient
        const result = yield* hydra.query("MATCH (n {id: $id}) RETURN n.ckey AS ckey", {
          id: vertexId(claimKeys[0]!)
        })
        return result.rows
      })
    )
    expect(rows).toEqual([{ ckey: claimKeys[0] }])
  })
})
