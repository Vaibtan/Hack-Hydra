import type { DatasetSession } from "@palimpsest/dataset"
import {
  edgeId,
  vertexId,
  type DiscoveryInput,
  type EdgeWrite,
  type HydraMemory as HydraMemoryService,
  type MemoryNode,
  type MemoryPath,
  type PropertyValue,
  type VertexWrite
} from "@palimpsest/hydra"
import {
  CurrentHydraBookmark,
  describeExecutionPlan,
  makeExecutionPlan,
  renderMsPathsQuery,
  type Scalar
} from "@palimpsest/hydra/testing"
import { Effect, Option, Result } from "effect"
import { behaviorFake } from "./BehaviorFake.js"
import { planSourceTranscriptWrite } from "../src/SourceTranscript.js"
import type { SourceRevision } from "../src/IngestManifest.js"

// ---------------------------------------------------------------------------
// In-memory Hydra double honoring the memory service's commit semantics.
// ---------------------------------------------------------------------------

export interface StoredVertex {
  readonly label: string
  readonly properties: Record<string, Scalar>
}

export interface StoredRelation {
  readonly type: string
  readonly srcKey: string
  readonly dstKey: string
  readonly properties: Record<string, Scalar>
}

export const relIdentity = (srcKey: string, type: string, dstKey: string): string =>
  `${srcKey}|${type}|${dstKey}`

export const makeHydraMemory = () => {
  const vertices = new Map<string, StoredVertex>()
  const relations = new Map<string, StoredRelation>()
  const calls = { commitWrites: 0 }
  /** Tamper hook fired inside discoverPaths — verification's first read after writes. */
  let onRead: (() => void) | undefined

  const merge = (label: string, key: string, properties: Readonly<Record<string, Scalar>>): void => {
    const existing = vertices.get(key)
    vertices.set(key, { label, properties: { ...existing?.properties, ...properties } })
  }

  const node = (key: string): MemoryNode | undefined => {
    const vertex = vertices.get(key)
    if (vertex === undefined) return undefined
    return {
      id: vertexId(key),
      key,
      labels: [vertex.label],
      properties: { ...vertex.properties }
    }
  }

  const commitVertices = (rows: ReadonlyArray<VertexWrite>): void => {
    for (const row of rows) merge(row.label, row.key, row.properties)
  }

  const commitEdges = (rows: ReadonlyArray<EdgeWrite>): void => {
    for (const row of rows) {
      relations.set(relIdentity(row.srcKey, row.type, row.dstKey), {
        type: row.type,
        srcKey: row.srcKey,
        dstKey: row.dstKey,
        properties: { ...row.properties }
      })
    }
  }

  const client = behaviorFake<HydraMemoryService>({
    commitWrites: (input: {
      readonly vertices?: ReadonlyArray<VertexWrite>
      readonly edges?: ReadonlyArray<EdgeWrite>
    }) =>
      Effect.sync(() => {
        calls.commitWrites++
        commitVertices(input.vertices ?? [])
        commitEdges(input.edges ?? [])
        return {
          vertices: input.vertices?.length ?? 0,
          edges: input.edges?.length ?? 0
        }
      }),
    resolveNode: (lookup: { readonly label: string; readonly key: string; readonly properties: ReadonlyArray<string> }) =>
      Effect.sync(() => {
        const vertex = vertices.get(lookup.key)
        if (vertex === undefined || vertex.label !== lookup.label) return Option.none<MemoryNode>()
        const projected = lookup.properties.flatMap((property) => {
          const value = vertex.properties[property]
          return value === undefined ? [] : [[property, value] as const]
        })
        return Option.some({
          id: vertexId(lookup.key),
          key: lookup.key,
          labels: [lookup.label],
          properties: Object.fromEntries(projected)
        })
      }),
    readGraphIdentities: (kind: "relationship" | "vertex", numericId: number) =>
      Effect.sync(() => {
        if (kind === "vertex") {
          return [...vertices.keys()].filter((key) => vertexId(key) === numericId)
        }
        return [...relations.values()]
          .filter((relation) => edgeId(relation.srcKey, relation.type, relation.dstKey) === numericId)
          .map((relation) => relIdentity(relation.srcKey, relation.type, relation.dstKey))
      }),
    scanKeys: (scan: {
      readonly label: string
      readonly keyProperty: string
      readonly filterProperty: string
      readonly filterValue: PropertyValue
    }) =>
      Effect.sync(() => {
        const keys: Array<string> = []
        for (const vertex of vertices.values()) {
          if (vertex.label !== scan.label) continue
          if (vertex.properties[scan.filterProperty] !== scan.filterValue) continue
          keys.push(String(vertex.properties[scan.keyProperty] ?? ""))
        }
        return keys
      }),
    discoverPaths: (input: DiscoveryInput) =>
      Effect.sync(() => {
        const rendered = renderMsPathsQuery(input)
        const plan = makeExecutionPlan({ queryText: rendered.query, parameters: rendered.parameters })
        if (input.sourceValues.length === 0) return { paths: [], plan }
        onRead?.()
        const paths: Array<MemoryPath> = []
        for (const sourceValue of input.sourceValues) {
          const entry = [...vertices.entries()].find(
            ([, vertex]) =>
              vertex.label === input.sourceLabel &&
              vertex.properties[input.sourceProperty] === sourceValue
          )
          if (entry === undefined) continue
          const [sourceKey] = entry
          const sourceNode = node(sourceKey)
          if (sourceNode === undefined) continue
          for (const relation of relations.values()) {
            if (!input.relTypes.includes(relation.type)) continue
            const outgoing = relation.srcKey === sourceKey
            const incoming = relation.dstKey === sourceKey
            if (input.relDirection === "outgoing" && !outgoing) continue
            if (input.relDirection === "incoming" && !incoming) continue
            if (!outgoing && !incoming) continue
            const otherKey = outgoing ? relation.dstKey : relation.srcKey
            const otherNode = node(otherKey)
            if (otherNode === undefined) continue
            paths.push({
              // Path nodes follow true edge direction, as HydraDB returns them.
              nodes: outgoing ? [sourceNode, otherNode] : [otherNode, sourceNode],
              relationships: [
                {
                  id: edgeId(relation.srcKey, relation.type, relation.dstKey),
                  key: relIdentity(relation.srcKey, relation.type, relation.dstKey),
                  type: relation.type,
                  src: vertexId(relation.srcKey),
                  dst: vertexId(relation.dstKey),
                  properties: { ...relation.properties }
                }
              ]
            })
          }
        }
        return { paths, plan }
    }),
    describeExecutionPlan,
    lastBookmark: CurrentHydraBookmark,
    withCausalBookmark: <A, E, R>(
      _bookmark: string | undefined,
      operation: Effect.Effect<A, E, R>
    ) => operation
  })

  return {
    client,
    vertices,
    relations,
    calls,
    merge,
    set onRead(hook: (() => void) | undefined) {
      onRead = hook
    }
  }
}

export type HydraMemory = ReturnType<typeof makeHydraMemory>

/** Mirror the real SourceTranscript write into the fake store. */
export const writeSourcePlane = (
  memory: HydraMemory,
  revision: SourceRevision,
  session: DatasetSession
): void => {
  const write = Result.getOrThrow(planSourceTranscriptWrite(revision, session))
  memory.merge("MemoryScope", write.scope.key, write.scope.properties)
  memory.merge("SourceSession", write.session.key, write.session.properties)
  for (const turn of write.turns) memory.merge("SourceTurn", turn.key, turn.properties)
  for (const chunk of write.chunks) memory.merge("SourceTurnChunk", chunk.key, chunk.properties)
  for (const relation of write.relations) {
    memory.relations.set(relIdentity(relation.srcKey, relation.type, relation.dstKey), {
      type: relation.type,
      srcKey: relation.srcKey,
      dstKey: relation.dstKey,
      properties: {}
    })
  }
}
