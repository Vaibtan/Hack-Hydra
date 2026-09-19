/** JSON-compatible value accepted by HydraDB request envelopes. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue }

/** JSON object accepted by HydraDB request envelopes. */
export type JsonObject = Readonly<Record<string, JsonValue>>
