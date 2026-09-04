import { canonicalJson } from "../SourceIdentity.js"
import type { UserStats } from "../User.js"
import { InvalidProjectionDelta, type ApplyProjectionDelta } from "./Types.js"

const PROJECTION_DELTA_FORMAT = "palimpsest.projection-delta.v1"

const STAT_FIELDS = [
  "claims",
  "entities",
  "slots",
  "tokens",
  "sessions",
  "turns",
  "supersessions",
  "contestedSlots"
] as const satisfies ReadonlyArray<keyof UserStats>

type StatField = (typeof STAT_FIELDS)[number]

export interface ProjectionDeltaPayload {
  readonly canonicalJson: string
  readonly stats: UserStats
  readonly tokenDf: ReadonlyMap<string, number>
  readonly slotClaims: ReadonlyMap<string, number>
}

const statsFrom = (read: (field: StatField) => number): UserStats => ({
  claims: read("claims"),
  entities: read("entities"),
  slots: read("slots"),
  tokens: read("tokens"),
  sessions: read("sessions"),
  turns: read("turns"),
  supersessions: read("supersessions"),
  contestedSlots: read("contestedSlots")
})

const statsRecord = (stats: UserStats): Record<StatField, number> =>
  Object.fromEntries(STAT_FIELDS.map((field) => [field, stats[field]])) as Record<StatField, number>

export const assertNonNegativeSafeInteger = (
  value: unknown,
  field: InvalidProjectionDelta["field"],
  detail: string
): number => {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 0) {
    throw new InvalidProjectionDelta({ field, reason: `${detail} must be a non-negative safe integer` })
  }
  return value
}

export const validateStats = (value: unknown): UserStats => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidProjectionDelta({ field: "stats", reason: "must be an object" })
  }
  const record = value as Record<string, unknown>
  return statsFrom((field) => assertNonNegativeSafeInteger(record[field], "stats", field))
}

const validateCountMap = (
  value: ReadonlyMap<string, number>,
  field: "tokenDf" | "slotClaims"
): ReadonlyMap<string, number> => {
  const validated = new Map<string, number>()
  for (const [key, count] of value) {
    if (key.trim().length === 0) {
      throw new InvalidProjectionDelta({ field, reason: "keys must not be empty" })
    }
    validated.set(key, assertNonNegativeSafeInteger(count, field, `value for ${key}`))
  }
  return validated
}

const mapEntries = (entries: ReadonlyMap<string, number>): ReadonlyArray<readonly [string, number]> =>
  [...entries.entries()].sort(([left], [right]) => left.localeCompare(right))

const encodePayload = (
  stats: UserStats,
  tokenDf: ReadonlyMap<string, number>,
  slotClaims: ReadonlyMap<string, number>
): ProjectionDeltaPayload => ({
  canonicalJson: canonicalJson({
    format: PROJECTION_DELTA_FORMAT,
    slot_claims: mapEntries(slotClaims),
    stats: statsRecord(stats),
    token_df: mapEntries(tokenDf)
  }),
  stats,
  tokenDf,
  slotClaims
})

export const projectionPayload = (input: ApplyProjectionDelta): ProjectionDeltaPayload =>
  encodePayload(
    validateStats(input.stats),
    validateCountMap(input.tokenDf, "tokenDf"),
    validateCountMap(input.slotClaims, "slotClaims")
  )

const decodeEntries = (
  entries: ReadonlyArray<unknown>,
  field: "tokenDf" | "slotClaims"
): ReadonlyMap<string, number> => {
  const result = new Map<string, number>()
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") {
      throw new Error(`projection delta ${field} entry was invalid`)
    }
    result.set(entry[0], assertNonNegativeSafeInteger(entry[1], field, `value for ${entry[0]}`))
  }
  return result
}

export const decodeProjectionPayload = (serialized: string): ProjectionDeltaPayload => {
  const parsed = JSON.parse(serialized) as {
    readonly format?: unknown
    readonly stats?: unknown
    readonly token_df?: unknown
    readonly slot_claims?: unknown
  }
  if (parsed.format !== PROJECTION_DELTA_FORMAT) {
    throw new Error("projection delta format was invalid")
  }
  if (!Array.isArray(parsed.token_df) || !Array.isArray(parsed.slot_claims)) {
    throw new Error("projection delta count maps were invalid")
  }
  const payload = encodePayload(
    validateStats(parsed.stats),
    validateCountMap(decodeEntries(parsed.token_df, "tokenDf"), "tokenDf"),
    validateCountMap(decodeEntries(parsed.slot_claims, "slotClaims"), "slotClaims")
  )
  if (payload.canonicalJson !== serialized) {
    throw new Error("projection delta was not canonical JSON")
  }
  return payload
}

export const statsJson = (stats: UserStats): string => canonicalJson(statsRecord(stats))

export const decodeStatsJson = (value: string): UserStats => validateStats(JSON.parse(value) as unknown)

export const addStats = (left: UserStats, right: UserStats): UserStats =>
  statsFrom((field) => left[field] + right[field])

export const sameStats = (left: UserStats, right: UserStats): boolean =>
  STAT_FIELDS.every((field) => left[field] === right[field])

export const addCounts = (target: Map<string, number>, source: ReadonlyMap<string, number>): void => {
  for (const [key, value] of source) target.set(key, (target.get(key) ?? 0) + value)
}

export const sameCounts = (left: ReadonlyMap<string, number>, right: ReadonlyMap<string, number>): boolean =>
  left.size === right.size && [...left].every(([key, value]) => right.get(key) === value)
