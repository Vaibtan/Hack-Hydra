import { HttpClient } from "effect/unstable/http"
import { Config, Context, Effect, Layer, Option, Schema } from "effect"
import { HydraClient } from "./Client.js"
import {
  FULL_KEY_PROPERTY,
  renderKeyScanQuery,
  renderMsPathsQuery,
  type RelDirection
} from "./Cypher.js"
import { isHydraPath, type HydraNode, type HydraPath, type HydraRelationship, type Row } from "./Decode.js"
import type { HydraError } from "./Errors.js"
import { vertexId } from "./Ids.js"

/** Scalar property values the memory plane reads and writes; engine cells decode into these. */
export const PropertyValueSchema = Schema.Union([Schema.String, Schema.Number, Schema.Boolean])
export type PropertyValue = typeof PropertyValueSchema.Type

export type MemoryProperties = Readonly<Record<string, PropertyValue>>

export interface MemoryNode {
  readonly id: number
  /** Stable application key, separated from the engine's reserved identity property. */
  readonly key: string
  readonly labels: ReadonlyArray<string>
  readonly properties: MemoryProperties
}

export interface MemoryEdge {
  readonly id: number | null
  /** Stable application key, separated from the engine's reserved identity property. */
  readonly key: string
  readonly type: string
  readonly src: number
  readonly dst: number
  readonly properties: MemoryProperties
}

export interface MemoryPath {
  readonly nodes: ReadonlyArray<MemoryNode>
  readonly relationships: ReadonlyArray<MemoryEdge>
}

export type { RelDirection }

/** Bounded candidate-discovery / slot-expansion walk. Bounds stay on this side of the seam. */
export interface DiscoveryInput {
  readonly sourceLabel: string
  readonly sourceProperty: string
  readonly sourceValues: ReadonlyArray<string>
  readonly targetLabel?: string
  readonly targetProperty?: string
  readonly targetValues?: ReadonlyArray<string>
  readonly relTypes: ReadonlyArray<string>
  readonly relDirection: RelDirection
  readonly maxLen: number
  readonly pathCount?: number
}

/** Receipt-safe diagnostic projection of an opaque execution plan. */
export interface ExecutionPlanDiagnostic {
  readonly queryText: string
  readonly parameters: Readonly<Record<string, string | number>>
}

const executionPlanBrand: unique symbol = Symbol("palimpsest.ExecutionPlan")

/** Opaque engine execution-plan handle; only the adapter can construct one. */
export interface ExecutionPlan {
  readonly [executionPlanBrand]: true
}

const executionPlanDiagnostics = new WeakMap<ExecutionPlan, ExecutionPlanDiagnostic>()

/** Internal/test constructor; production callers receive handles from discovery operations. */
export const makeExecutionPlan = (diagnostic: ExecutionPlanDiagnostic): ExecutionPlan => {
  const plan: ExecutionPlan = { [executionPlanBrand]: true }
  executionPlanDiagnostics.set(plan, diagnostic)
  return plan
}

export const describeExecutionPlan = (plan: ExecutionPlan): ExecutionPlanDiagnostic => {
  const diagnostic = executionPlanDiagnostics.get(plan)
  if (diagnostic === undefined) throw new Error("execution plan was not created by HydraMemory")
  return diagnostic
}

export interface DiscoveryResult {
  readonly paths: ReadonlyArray<MemoryPath>
  readonly plan: ExecutionPlan
}

export interface VertexWrite {
  readonly label: string
  readonly key: string
  readonly properties: Readonly<Record<string, PropertyValue>>
}

export interface EdgeWrite {
  readonly type: string
  readonly srcLabel: string
  readonly srcKey: string
  readonly dstLabel: string
  readonly dstKey: string
  readonly properties?: Readonly<Record<string, PropertyValue>>
}

export interface CommitReport {
  readonly vertices: number
  readonly edges: number
}

export interface NodeLookup {
  readonly label: string
  readonly key: string
  readonly properties: ReadonlyArray<string>
}

export interface KeyScan {
  readonly label: string
  readonly keyProperty: string
  readonly filterProperty: string
  readonly filterValue: PropertyValue
}

export const memoryNodeFromHydra = (node: HydraNode): MemoryNode => ({
  id: node.id,
  key: String(node.properties[FULL_KEY_PROPERTY] ?? ""),
  labels: node.labels,
  properties: Object.fromEntries(
    Object.entries(node.properties).filter(([name]) => name !== FULL_KEY_PROPERTY)
  )
})

export const memoryEdgeFromHydra = (edge: HydraRelationship): MemoryEdge => ({
  id: edge.id,
  key: String(edge.properties[FULL_KEY_PROPERTY] ?? ""),
  type: edge.type,
  src: edge.src,
  dst: edge.dst,
  properties: Object.fromEntries(
    Object.entries(edge.properties).filter(([name]) => name !== FULL_KEY_PROPERTY)
  )
})

export const memoryPathFromHydra = (path: HydraPath): MemoryPath => ({
  nodes: path.nodes.map(memoryNodeFromHydra),
  relationships: path.relationships.map(memoryEdgeFromHydra)
})

/** Single-record lookups project scalars only; nulls and non-scalar cells never cross the seam. */
export const memoryNodeFromRow = (label: string, key: string, row: Row): MemoryNode => {
  const properties: Record<string, PropertyValue> = {}
  for (const [name, cell] of Object.entries(row)) {
    if (name === FULL_KEY_PROPERTY || cell === null || isHydraPath(cell)) continue
    properties[name] = cell
  }
  return { id: vertexId(key), key, labels: [label], properties }
}

const make = Effect.gen(function* () {
  const client = yield* HydraClient

  const commitWrites = (
    input: {
      readonly vertices?: ReadonlyArray<VertexWrite>
      readonly edges?: ReadonlyArray<EdgeWrite>
    }
  ): Effect.Effect<CommitReport, HydraError> =>
    Effect.gen(function* () {
      const byLabel = new Map<string, Array<VertexWrite>>()
      for (const vertex of input.vertices ?? []) {
        const bucket = byLabel.get(vertex.label) ?? []
        bucket.push(vertex)
        byLabel.set(vertex.label, bucket)
      }
      let vertices = 0
      for (const [label, rows] of byLabel) {
        vertices += yield* client.batchMerge(label, rows)
      }
      const byType = new Map<string, Array<EdgeWrite>>()
      for (const edge of input.edges ?? []) {
        const bucket = byType.get(edge.type) ?? []
        bucket.push(edge)
        byType.set(edge.type, bucket)
      }
      let edges = 0
      for (const [type, rows] of byType) {
        edges += yield* client.batchRel(type, rows)
      }
      return { vertices, edges }
    })

  const resolveNode = (lookup: NodeLookup): Effect.Effect<Option.Option<MemoryNode>, HydraError> =>
    Effect.map(
      client.getById(lookup.label, lookup.key, lookup.properties),
      (found) => Option.map(found, (row) => memoryNodeFromRow(lookup.label, lookup.key, row))
    )

  const discoverPaths = (input: DiscoveryInput): Effect.Effect<DiscoveryResult, HydraError> =>
    Effect.gen(function* () {
      const rendered = renderMsPathsQuery(input)
      const plan = makeExecutionPlan({ queryText: rendered.query, parameters: rendered.parameters })
      if (input.sourceValues.length === 0) return { paths: [], plan }
      const paths = yield* client.msPaths(input)
      return { paths: paths.map(memoryPathFromHydra), plan }
    })

  const scanKeys = (scan: KeyScan): Effect.Effect<ReadonlyArray<string>, HydraError> =>
    Effect.map(
      client.query(renderKeyScanQuery(scan), { value: scan.filterValue }),
      (result) => result.rows.map((row) => String(row["key"]))
    )

  return {
    commitWrites,
    resolveNode,
    discoverPaths,
    describeExecutionPlan,
    scanKeys,
    deleteByKeys: client.deleteByKeys,
    readGraphIdentities: client.readGraphIdentities,
    withCausalBookmark: client.withCausalBookmark,
    lastBookmark: client.lastBookmark
  } as const
})

export type HydraMemory = Effect.Success<typeof make>
const HydraMemoryTag = Context.Service<HydraMemory>("palimpsest/HydraMemory")
export const HydraMemory = Object.assign(HydraMemoryTag, { layer: Layer.effect(HydraMemoryTag, make) })

/**
 * Production wiring: the memory operations over the engine client. Callers
 * provide an HTTP client; the raw engine service never crosses this seam.
 */
export const HydraMemoryLive: Layer.Layer<HydraMemory, Config.ConfigError, HttpClient.HttpClient> =
  HydraMemory.layer.pipe(Layer.provide(HydraClient.layer))
