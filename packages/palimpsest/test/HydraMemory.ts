import type { DatasetSession } from "@palimpsest/dataset"
import {
  CurrentHydraBookmark,
  edgeId,
  FULL_KEY_PROPERTY,
  HydraClient,
  vertexId,
  type HydraPath,
  type MsPathsConfig,
  type RelRow,
  type Row,
  type Scalar,
  type VertexRow
} from "@palimpsest/hydra"
import { Effect, Option, Result } from "effect"
import { behaviorFake } from "./BehaviorFake.js"
import { planSourceTranscriptWrite } from "../src/SourceTranscript.js"
import type { SourceRevision } from "../src/IngestManifest.js"

// ---------------------------------------------------------------------------
// In-memory Hydra double honoring the client's merge semantics.
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
  const calls = { batchMerge: 0, batchRel: 0 }
  /** Tamper hook fired inside msPaths — verification's first read after writes. */
  let onRead: (() => void) | undefined

  const merge = (label: string, key: string, properties: Readonly<Record<string, Scalar>>): void => {
    const existing = vertices.get(key)
    vertices.set(key, { label, properties: { ...existing?.properties, ...properties } })
  }

  const node = (key: string) => {
    const vertex = vertices.get(key)
    if (vertex === undefined) return undefined
    return {
      id: vertexId(key),
      labels: [vertex.label],
      properties: { ...vertex.properties, [FULL_KEY_PROPERTY]: key }
    }
  }

  const client = behaviorFake<HydraClient>({
    batchMerge: (label: string, rows: ReadonlyArray<VertexRow>) =>
      Effect.sync(() => {
        calls.batchMerge++
        for (const row of rows) merge(label, row.key, row.properties)
        return rows.length
      }),
    batchRel: (type: string, rows: ReadonlyArray<RelRow>) =>
      Effect.sync(() => {
        calls.batchRel++
        for (const row of rows) {
          relations.set(relIdentity(row.srcKey, type, row.dstKey), {
            type,
            srcKey: row.srcKey,
            dstKey: row.dstKey,
            properties: { ...row.properties }
          })
        }
        return rows.length
      }),
    getById: (label: string, key: string, properties: ReadonlyArray<string>) =>
      Effect.sync(() => {
        const vertex = vertices.get(key)
        if (vertex === undefined || vertex.label !== label) return Option.none<Row>()
        const row: Row = { [FULL_KEY_PROPERTY]: key }
        for (const property of properties) row[property] = vertex.properties[property] ?? null
        return Option.some(row)
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
    msPaths: (config: MsPathsConfig) =>
      Effect.sync(() => {
        onRead?.()
        const paths: Array<HydraPath> = []
        for (const sourceValue of config.sourceValues) {
          const entry = [...vertices.entries()].find(
            ([, vertex]) =>
              vertex.label === config.sourceLabel &&
              vertex.properties[config.sourceProperty] === sourceValue
          )
          if (entry === undefined) continue
          const [sourceKey] = entry
          const sourceNode = node(sourceKey)
          if (sourceNode === undefined) continue
          for (const relation of relations.values()) {
            if (!config.relTypes.includes(relation.type)) continue
            const outgoing = relation.srcKey === sourceKey
            const incoming = relation.dstKey === sourceKey
            if (config.relDirection === "outgoing" && !outgoing) continue
            if (config.relDirection === "incoming" && !incoming) continue
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
                  type: relation.type,
                  src: vertexId(relation.srcKey),
                  dst: vertexId(relation.dstKey),
                  properties: {
                    ...relation.properties,
                    [FULL_KEY_PROPERTY]: relIdentity(
                      relation.srcKey,
                      relation.type,
                      relation.dstKey
                    )
                  }
                }
              ]
            })
          }
        }
        return paths
      }),
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
  const plan = Result.getOrThrow(planSourceTranscriptWrite(revision, session))
  memory.merge("MemoryScope", plan.scope.key, plan.scope.properties)
  memory.merge("SourceSession", plan.session.key, plan.session.properties)
  for (const turn of plan.turns) memory.merge("SourceTurn", turn.key, turn.properties)
  for (const chunk of plan.chunks) memory.merge("SourceTurnChunk", chunk.key, chunk.properties)
  for (const relation of plan.relations) {
    memory.relations.set(relIdentity(relation.srcKey, relation.type, relation.dstKey), {
      type: relation.type,
      srcKey: relation.srcKey,
      dstKey: relation.dstKey,
      properties: {}
    })
  }
}
