import { Schema } from "effect"

/** JSON object accepted by persisted evaluation artifact decoders. */
export interface JsonObject {
  readonly [key: string]: JsonValue
}

/** JSON value accepted by persisted evaluation artifact decoders. */
export type JsonValue = string | number | boolean | null | ReadonlyArray<JsonValue> | JsonObject

const isJsonArray = (value: JsonValue): value is ReadonlyArray<JsonValue> => Array.isArray(value)

const byCodeUnit = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

/**
 * Serialize a JSON value with object keys in UTF-16 code-unit order and no whitespace, so two
 * equal values share one byte form regardless of key insertion order or the host locale.
 *
 * @param value - The JSON value to serialize.
 * @returns The canonical serialization.
 */
export const canonicalJson = (value: JsonValue): string => {
  if (
    value === null ||
    Schema.is(Schema.String)(value) ||
    Schema.is(Schema.Number)(value) ||
    Schema.is(Schema.Boolean)(value)
  ) {
    return JSON.stringify(value)
  }
  if (isJsonArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  return `{${Object.entries(value)
    .sort(([left], [right]) => byCodeUnit(left, right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`
}
