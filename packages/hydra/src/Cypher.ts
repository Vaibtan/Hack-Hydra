/**
 * The Cypher-subset rules live here and nowhere else. Callers of the client
 * never learn that string lists have to be inlined or that `maxLen` is capped.
 */

/** Server caps, from `vendor/hydradb/src/core/config.rs`. */
export const MAX_TRAVERSAL_HOPS = 16
export const MAX_QUERY_RESULT_VERTICES = 100_000
export const MAX_BODY_BYTES = 1_000_000
/**
 * Measured against HydraDB 0.1.0 by bisection: a string property of 32 743
 * UTF-8 bytes is stored, 32 744 fails the write with a 500 and the opaque
 * message "internal query execution error". The cap is on bytes, not code
 * points (16 371 two-byte characters is the same boundary).
 */
export const MAX_STRING_PROPERTY_BYTES = 32_743

/**
 * A **source-only** `algo.MSpaths` walk returns one path per source value
 * unless told otherwise, and says nothing about having stopped — a recall cap
 * that looks exactly like an answer. Walking the `User` root over
 * `HAS_SESSION` returned 1 of 39 sessions this way.
 *
 * A walk *with* a constant-valued target selector is not subject to it: every
 * source→target pair comes back. That is what `Claim.kind` is for, and it is
 * also the faster plan by an order of magnitude — raising `pathCount` on the
 * convergence query took its median from 0.12 s to 14 s while returning
 * byte-identical evidence, because the engine then enumerates paths it would
 * otherwise prune.
 *
 * So the ceiling is applied to source-only walks only, and a caller that wants
 * fewer paths says so. Nobody is truncated by omission; nobody pays for
 * breadth a target selector already guarantees.
 */
export const DEFAULT_PATH_COUNT = MAX_QUERY_RESULT_VERTICES

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

/** HydraDB string literal: single-quoted, backslash-escaped. */
const literal = (value: string): string => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`

const literalList = (values: ReadonlyArray<string>): string => `[${values.map(literal).join(",")}]`

/**
 * Identifiers (labels, property names, relationship types) are interpolated
 * into the statement, so they must not be attacker-shaped. Our schema only ever
 * uses fixed ASCII names; anything else is a bug, not a query.
 */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

const requireIdentifier = (kind: string, value: string): string => {
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

  const parameters: Record<string, string | number> = {
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
