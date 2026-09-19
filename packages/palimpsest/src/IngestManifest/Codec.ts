import { Result, Schema } from "effect"
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

const statsRecord = (stats: UserStats): Record<StatField, number> => ({
  claims: stats.claims,
  entities: stats.entities,
  slots: stats.slots,
  tokens: stats.tokens,
  sessions: stats.sessions,
  turns: stats.turns,
  supersessions: stats.supersessions,
  contestedSlots: stats.contestedSlots
})

export const assertNonNegativeSafeInteger = (
  value: number,
  field: InvalidProjectionDelta["field"],
  detail: string
): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidProjectionDelta({ field, reason: `${detail} must be a non-negative safe integer` })
  }
  return value
}

export const validateStats = (value: UserStats): UserStats =>
  statsFrom((field) => assertNonNegativeSafeInteger(value[field], "stats", field))

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
  entries: ReadonlyArray<readonly [string, number]>,
  field: "tokenDf" | "slotClaims"
): ReadonlyMap<string, number> => {
  const result = new Map<string, number>()
  for (const entry of entries) {
    result.set(entry[0], assertNonNegativeSafeInteger(entry[1], field, `value for ${entry[0]}`))
  }
  return result
}

const UserStatsSchema = Schema.Struct({
  claims: Schema.Number,
  entities: Schema.Number,
  slots: Schema.Number,
  tokens: Schema.Number,
  sessions: Schema.Number,
  turns: Schema.Number,
  supersessions: Schema.Number,
  contestedSlots: Schema.Number
})

const CountEntriesSchema = Schema.Array(Schema.Tuple([Schema.String, Schema.Number]))
const ProjectionDeltaDescriptorSchema = Schema.Struct({
  format: Schema.Literal(PROJECTION_DELTA_FORMAT),
  slot_claims: CountEntriesSchema,
  stats: UserStatsSchema,
  token_df: CountEntriesSchema
})

export const decodeProjectionPayload = (serialized: string): ProjectionDeltaPayload => {
  const decoded = Schema.decodeUnknownResult(ProjectionDeltaDescriptorSchema)(JSON.parse(serialized))
  if (Result.isFailure(decoded)) throw new Error("projection delta encoding was invalid")
  const parsed = decoded.success
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

export const decodeStatsJson = (value: string): UserStats => {
  const decoded = Schema.decodeUnknownResult(UserStatsSchema)(JSON.parse(value))
  if (Result.isFailure(decoded)) throw new Error("projection stats encoding was invalid")
  return validateStats(decoded.success)
}

export const addStats = (left: UserStats, right: UserStats): UserStats =>
  statsFrom((field) => left[field] + right[field])

export const sameStats = (left: UserStats, right: UserStats): boolean =>
  STAT_FIELDS.every((field) => left[field] === right[field])

export const addCounts = (target: Map<string, number>, source: ReadonlyMap<string, number>): void => {
  for (const [key, value] of source) target.set(key, (target.get(key) ?? 0) + value)
}

export const sameCounts = (left: ReadonlyMap<string, number>, right: ReadonlyMap<string, number>): boolean =>
  left.size === right.size && [...left].every(([key, value]) => right.get(key) === value)
