import { Schema } from "effect"
import { MAX_STRING_PROPERTY_BYTES } from "./Cypher.js"
import {
  HYDRA_ENGINE_ERROR_CODES,
  HydraEngineError,
  HydraLimitError,
  HydraParseError,
  HydraUnavailable,
  type HydraEngineErrorCode,
  type HydraError
} from "./Errors.js"
import type { JsonObject } from "./JsonValue.js"

/** Safe subset of an error response used for public failure classification. */
export const HydraErrorBodySchema = Schema.Struct({
  error: Schema.optionalKey(
    Schema.Struct({
      code: Schema.optionalKey(Schema.String),
      message: Schema.optionalKey(Schema.String)
    })
  )
})

export type HydraErrorBody = typeof HydraErrorBodySchema.Type

const engineErrorContract: Readonly<
  Record<HydraEngineErrorCode, { readonly status: number; readonly retryable: boolean; readonly reason: string }>
> = {
  idempotency_conflict: {
    status: 409,
    retryable: false,
    reason: "the request id was already used for different content"
  },
  write_conflict: {
    status: 409,
    retryable: true,
    reason: "the graph write conflicted with a concurrent operation"
  },
  writer_unavailable: {
    status: 503,
    retryable: true,
    reason: "the graph writer is not available for this cell"
  },
  writer_lease_unavailable: {
    status: 503,
    retryable: true,
    reason: "the durable writer lease cannot be acquired yet"
  },
  object_store_unavailable: {
    status: 503,
    retryable: true,
    reason: "durable graph storage is temporarily unavailable"
  }
}

const isHydraEngineErrorCode = (value: string): value is HydraEngineErrorCode =>
  HYDRA_ENGINE_ERROR_CODES.some((known) => known === value)

/** Reviewed engine codes with their declared status; every other 5xx is a generic unavailability; limits are recognised by message so they survive a status change. */
export const classifyHydraHttpError = (
  status: number,
  body: HydraErrorBody,
  query: string
): HydraError => {
  const error = body.error
  const responseCode = error?.code
  if (responseCode !== undefined && isHydraEngineErrorCode(responseCode)) {
    const contract = engineErrorContract[responseCode]
    if (contract.status === status) {
      return new HydraEngineError({ code: responseCode, query, ...contract })
    }
  }

  if (status >= 500) {
    return new HydraUnavailable({ reason: `HydraDB returned HTTP ${status}`, status })
  }

  const reason = error?.message ?? `HTTP ${status}`
  const code = error?.code ?? `http_${status}`
  const isLimit = /timeout|exceeded|too large|too many|limit is/i.test(reason)
  if (isLimit) return new HydraLimitError({ reason, status, query })
  if (status === 400 || status === 422) return new HydraParseError({ reason, code, query })
  if (status === 413 || status === 429) return new HydraLimitError({ reason, status, query })
  return new HydraUnavailable({ reason: `HydraDB returned HTTP ${status}`, status })
}

export const isRetryable = (error: HydraError): boolean =>
  error instanceof HydraEngineError && error.retryable

export const isLimit = (error: unknown): error is HydraLimitError => error instanceof HydraLimitError

/** The engine answers an oversize string with a bare 500, so the cap is checked before sending. */
export const oversizeProperty = (
  row: JsonObject
): { readonly property: string; readonly bytes: number } | undefined => {
  for (const [property, value] of Object.entries(row)) {
    if (!Schema.is(Schema.String)(value)) continue
    const bytes = Buffer.byteLength(value, "utf8")
    if (bytes > MAX_STRING_PROPERTY_BYTES) return { property, bytes }
  }
  return undefined
}
