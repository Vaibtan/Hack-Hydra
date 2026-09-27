import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { describe, expect, it } from "vitest"
import { FULL_KEY_PROPERTY, renderMsPathsQuery } from "../../src/Cypher.js"
import { edgeId, vertexId } from "../../src/Ids.js"
import { HydraClient } from "../../src/Client.js"
import {
  HydraMemory,
  memoryNodeFromRow,
  memoryPathFromHydra,
  type DiscoveryInput
} from "../../src/Memory.js"

interface CapturedRequest {
  readonly query: string
  readonly parameters: unknown
}

interface TestEnvelope {
  readonly query_id: string
  readonly columns: ReadonlyArray<string>
  readonly rows: ReadonlyArray<unknown>
  readonly read_epoch: number
  readonly next_cursor: null
  readonly bookmark: null
}

const envelope = (columns: ReadonlyArray<string>, rows: ReadonlyArray<unknown>): TestEnvelope => ({
  query_id: "query-1",
  columns,
  rows,
  read_epoch: 1,
  next_cursor: null,
  bookmark: null
})

const fakeHttp = (
  captured: Array<CapturedRequest>,
  respond: (body: { readonly query: string }) => TestEnvelope
): HttpClient.HttpClient =>
  HttpClient.make((request) =>
    Effect.sync(() => {
      if (request.body._tag !== "Uint8Array") throw new Error("expected a JSON request body")
      // SAFETY: the transport only sends { query, parameters? } JSON bodies; the fake truncates to what it captures.
      const body = JSON.parse(new TextDecoder().decode(request.body.body)) as {
        readonly query: string
        readonly parameters?: unknown
      }
      captured.push({ query: body.query, parameters: body.parameters })
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(respond(body)), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
    })
  )

const MemoryTestLive = (http: HttpClient.HttpClient) =>
  HydraMemory.layer.pipe(
    Layer.provideMerge(HydraClient.layer),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http))
  )

const runMemory = <A, E>(
  http: HttpClient.HttpClient,
  effect: Effect.Effect<A, E, HydraMemory>
): Promise<A> => Effect.runPromise(Effect.provide(effect, MemoryTestLive(http)))

const SRC = "u1:tok:apple"
const DST = "u1:claim:1"

const pathCell = {
  type: "path",
  value: {
    nodes: [
      {
        id: vertexId(SRC),
        labels: ["Token"],
        properties: {
          tkey: { String: SRC },
          df: { Integer: 3 },
          [FULL_KEY_PROPERTY]: { String: SRC }
        }
      },
      {
        id: vertexId(DST),
        labels: ["Claim"],
        properties: {
          ckey: { String: DST },
          [FULL_KEY_PROPERTY]: { String: DST }
        }
      }
    ],
    relationships: [
      {
        id: edgeId(SRC, "HITS", DST),
        edge_type: "HITS",
        src: vertexId(SRC),
        dst: vertexId(DST),
        properties: {
          id: { Integer: edgeId(SRC, "HITS", DST) },
          [FULL_KEY_PROPERTY]: { String: `${SRC}|HITS|${DST}` }
        }
      }
    ]
  }
}

const discovery: DiscoveryInput = {
  sourceLabel: "Token",
  sourceProperty: "tkey",
  sourceValues: [SRC],
  relTypes: ["HITS"],
  relDirection: "outgoing",
  maxLen: 2
}

describe("HydraMemory", () => {
  it("returns memory paths plus the rendered query plan", async () => {
    const captured: Array<CapturedRequest> = []
    const http = fakeHttp(captured, () => envelope(["path"], [[pathCell]]))
    const result = await runMemory(
      http,
      Effect.gen(function* () {
        const memory = yield* HydraMemory
        return yield* memory.discoverPaths(discovery)
      })
    )
    expect(captured).toHaveLength(1)
    expect(captured[0]!.query).toBe(renderMsPathsQuery(discovery).query)
    const diagnostic = await runMemory(
      http,
      Effect.gen(function* () {
        const memory = yield* HydraMemory
        return memory.describeExecutionPlan(result.plan)
      })
    )
    expect(diagnostic.queryText).toBe(renderMsPathsQuery(discovery).query)
    expect(diagnostic.parameters).toEqual(renderMsPathsQuery(discovery).parameters)
    expect(result.paths).toHaveLength(1)
    expect(result.paths[0]!.nodes.map((node) => node.labels)).toEqual([["Token"], ["Claim"]])
    expect(result.paths[0]!.nodes.map((node) => node.key)).toEqual([SRC, DST])
    expect(result.paths[0]!.nodes[0]!.properties).toMatchObject({ tkey: SRC, df: 3 })
    expect(result.paths[0]!.relationships[0]).toMatchObject({ type: "HITS" })
  })

  it("short-circuits empty discovery without touching the engine", async () => {
    const captured: Array<CapturedRequest> = []
    const http = fakeHttp(captured, () => envelope(["path"], []))
    const result = await runMemory(
      http,
      Effect.gen(function* () {
        const memory = yield* HydraMemory
        return yield* memory.discoverPaths({ ...discovery, sourceValues: [] })
      })
    )
    expect(captured).toHaveLength(0)
    expect(result.paths).toEqual([])
    const diagnostic = await runMemory(
      http,
      Effect.gen(function* () {
        const memory = yield* HydraMemory
        return memory.describeExecutionPlan(result.plan)
      })
    )
    expect(diagnostic.queryText).toContain("algo.MSpaths")
  })

  it("groups vertex and edge writes by label and type", async () => {
    const captured: Array<CapturedRequest> = []
    const http = fakeHttp(captured, () => envelope([], []))
    const report = await runMemory(
      http,
      Effect.gen(function* () {
        const memory = yield* HydraMemory
        return yield* memory.commitWrites({
          vertices: [
            { label: "Claim", key: "c1", properties: { ckey: "c1" } },
            { label: "Token", key: "t1", properties: { tkey: "t1" } },
            { label: "Claim", key: "c2", properties: { ckey: "c2" } }
          ],
          edges: [
            { type: "HITS", srcLabel: "Token", srcKey: "t1", dstLabel: "Claim", dstKey: "c1" }
          ]
        })
      })
    )
    expect(report).toEqual({ vertices: 3, edges: 1 })
    expect(captured.map((request) => request.query)).toEqual([
      expect.stringContaining("SET n:Claim"),
      expect.stringContaining("SET n:Token"),
      expect.stringContaining("MERGE (s)-[r:HITS")
    ])
  })

  it("scans keys through the typed key-scan statement", async () => {
    const captured: Array<CapturedRequest> = []
    const http = fakeHttp(captured, () =>
      envelope(["key"], [[{ type: "string", value: "k1" }], [{ type: "integer", value: 7 }]])
    )
    const keys = await runMemory(
      http,
      Effect.gen(function* () {
        const memory = yield* HydraMemory
        return yield* memory.scanKeys({
          label: "Claim",
          keyProperty: "ckey",
          filterProperty: "uid",
          filterValue: "u1"
        })
      })
    )
    expect(captured[0]!.query).toBe("MATCH (n:Claim) WHERE n.uid = $value RETURN n.ckey AS key")
    expect(keys).toEqual(["k1", "7"])
  })

  it("resolves a node with scalar properties only", async () => {
    const captured: Array<CapturedRequest> = []
    const http = fakeHttp(captured, () =>
      envelope(
        ["text", "chunks", FULL_KEY_PROPERTY],
        [[{ type: "string", value: "hi" }, { type: "null" }, { type: "string", value: "turn-1" }]]
      )
    )
    const found = await runMemory(
      http,
      Effect.gen(function* () {
        const memory = yield* HydraMemory
        return yield* memory.resolveNode({ label: "SourceTurn", key: "turn-1", properties: ["text", "chunks"] })
      })
    )
    expect(captured[0]!.query).toContain("MATCH (n:SourceTurn {id: $id})")
    expect(found._tag).toBe("Some")
    if (found._tag === "Some") {
      expect(found.value.id).toBe(vertexId("turn-1"))
      expect(found.value.key).toBe("turn-1")
      expect(found.value.labels).toEqual(["SourceTurn"])
      expect(found.value.properties).toEqual({ text: "hi" })
    }
  })

  it("drops null and path cells when projecting a row", () => {
    const node = memoryNodeFromRow("Claim", "c1", {
      ckey: "c1",
      missing: null,
      nested: { nodes: [], relationships: [] }
    })
    expect(node).toEqual({
      id: vertexId("c1"),
      key: "c1",
      labels: ["Claim"],
      properties: { ckey: "c1" }
    })
  })

  it("preserves path shape across the memory mapping", () => {
    const mapped = memoryPathFromHydra({
      nodes: [{ id: 1, labels: ["Token"], properties: { tkey: "t" } }],
      relationships: []
    })
    expect(mapped).toEqual({
      nodes: [{ id: 1, key: "", labels: ["Token"], properties: { tkey: "t" } }],
      relationships: []
    })
  })
})
