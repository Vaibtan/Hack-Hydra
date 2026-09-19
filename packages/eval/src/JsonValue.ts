/** JSON object accepted by persisted evaluation artifact decoders. */
export interface JsonObject {
  readonly [key: string]: JsonValue
}

/** JSON value accepted by persisted evaluation artifact decoders. */
export type JsonValue = string | number | boolean | null | ReadonlyArray<JsonValue> | JsonObject
