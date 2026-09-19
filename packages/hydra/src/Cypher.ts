/** Server caps, from `vendor/hydradb/src/core/config.rs`; the string cap was measured by bisection. */
export const MAX_TRAVERSAL_HOPS = 16
export const MAX_QUERY_RESULT_VERTICES = 100_000
export const MAX_BODY_BYTES = 1_000_000
export const MAX_STRING_PROPERTY_BYTES = 32_743

/** Applied to source-only `MSpaths` walks only; a target selector already returns every pair. */
export const DEFAULT_PATH_COUNT = MAX_QUERY_RESULT_VERTICES

/** The property every record carries so a lossy numeric id can be verified against its full key on read. */
export const FULL_KEY_PROPERTY = "__palimpsest_full_key"

export type RelDirection = "outgoing" | "incoming" | "both"

export interface MsPathsConfig {
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

const literal = (value: string): string => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`

const literalList = (values: ReadonlyArray<string>): string => `[${values.map(literal).join(",")}]`

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

export const requireIdentifier = (kind: string, value: string): string => {
  if (!IDENTIFIER.test(value)) {
    throw new Error(`invalid ${kind} identifier: ${JSON.stringify(value)}`)
  }
  return value
}

export interface RenderedQuery {
  readonly query: string
  readonly parameters: Record<string, string | number>
}

export const renderMsPathsQuery = (config: MsPathsConfig): RenderedQuery => {
  if (!Number.isInteger(config.maxLen) || config.maxLen < 1 || config.maxLen > MAX_TRAVERSAL_HOPS) {
    throw new Error(`maxLen must be an integer in 1..${MAX_TRAVERSAL_HOPS}, got ${config.maxLen}`)
  }
  if (config.relTypes.length === 0) {
    throw new Error("relTypes must not be empty")
  }
  const hasTargetSelector = config.targetLabel !== undefined || config.targetProperty !== undefined
  if (hasTargetSelector && (config.targetValues === undefined || config.targetValues.length === 0)) {
    throw new Error("targetLabel/targetProperty require a non-empty targetValues list")
  }

  const parts: Array<string> = [
    `sourceLabel:${literal(requireIdentifier("sourceLabel", config.sourceLabel))}`,
    `sourceProperty:${literal(requireIdentifier("sourceProperty", config.sourceProperty))}`,
    `sourceValues:${literalList(config.sourceValues)}`
  ]
  if (config.targetLabel !== undefined) {
    parts.push(`targetLabel:${literal(requireIdentifier("targetLabel", config.targetLabel))}`)
  }
  if (config.targetProperty !== undefined) {
    parts.push(`targetProperty:${literal(requireIdentifier("targetProperty", config.targetProperty))}`)
  }
  if (config.targetValues !== undefined) {
    parts.push(`targetValues:${literalList(config.targetValues)}`)
  }
  parts.push(`relTypes:${literalList(config.relTypes.map((t) => requireIdentifier("relType", t)))}`)
  parts.push("relDirection:$relDirection")
  parts.push("maxLen:$maxLen")

  const parameters: RenderedQuery["parameters"] = {
    relDirection: config.relDirection,
    maxLen: config.maxLen
  }
  const pathCount = config.pathCount ?? (hasTargetSelector ? undefined : DEFAULT_PATH_COUNT)
  if (pathCount !== undefined) {
    parts.push("pathCount:$pathCount")
    parameters["pathCount"] = pathCount
  }

  return {
    query: `CALL algo.MSpaths({${parts.join(", ")}}) YIELD path RETURN path`,
    parameters
  }
}

/** `properties` must not include `FULL_KEY_PROPERTY`; it is projected last under its own name. */
export const renderGetByIdQuery = (label: string, properties: ReadonlyArray<string>): string => {
  requireIdentifier("label", label)
  const projection = properties
    .concat(FULL_KEY_PROPERTY)
    .map((property) => `n.${requireIdentifier("property", property)} AS ${property}`)
    .join(", ")
  return `MATCH (n:${label} {id: $id}) RETURN ${projection}`
}

/** Read every stored full identity that currently owns a global reduced id. */
export const renderGraphIdentityLookupQuery = (kind: "relationship" | "vertex"): string =>
  kind === "vertex"
    ? `MATCH (n {id: $id}) RETURN n.${FULL_KEY_PROPERTY} AS ${FULL_KEY_PROPERTY}`
    : `MATCH ()-[r]->() WHERE r.id = $id RETURN r.${FULL_KEY_PROPERTY} AS ${FULL_KEY_PROPERTY}`

export const renderVertexMergeStatement = (label: string, properties: ReadonlyArray<string>): string => {
  requireIdentifier("label", label)
  const assignments = [
    `n.${FULL_KEY_PROPERTY} = row.${FULL_KEY_PROPERTY}`,
    ...properties.map((p) => `n.${requireIdentifier("property", p)} = row.${p}`)
  ]
    .join(", ")
  return `UNWIND $rows AS row MERGE (n {id: row.id}) SET n:${label}, ${assignments}`
}

export const renderRelMergeStatement = (
  relType: string,
  srcLabel: string,
  dstLabel: string,
  properties: ReadonlyArray<string>
): string => {
  requireIdentifier("relType", relType)
  requireIdentifier("srcLabel", srcLabel)
  requireIdentifier("dstLabel", dstLabel)
  const setClause = ` SET ${[
    `r.${FULL_KEY_PROPERTY} = row.${FULL_KEY_PROPERTY}`,
    ...properties.map((p) => `r.${requireIdentifier("property", p)} = row.${p}`)
  ].join(", ")}`
  return (
    `UNWIND $rows AS row MATCH (s:${srcLabel} {id: row.s}), (d:${dstLabel} {id: row.d}) ` +
    `MERGE (s)-[r:${relType} {id: row.r}]->(d)${setClause}`
  )
}

export const DELETE_BY_ID_STATEMENT = "UNWIND $rows AS row MATCH (n {id: row.id}) DETACH DELETE n"
