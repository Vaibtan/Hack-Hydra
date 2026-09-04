import { Data } from "effect"

export const HYDRA_ENGINE_ERROR_CODES = [
  "idempotency_conflict",
  "write_conflict",
  "writer_unavailable",
  "writer_lease_unavailable",
  "object_store_unavailable"
] as const

export type HydraEngineErrorCode = (typeof HYDRA_ENGINE_ERROR_CODES)[number]

export class HydraEngineError extends Data.TaggedError("HydraEngineError")<{
  readonly code: HydraEngineErrorCode
  readonly status: number
  readonly query: string
  readonly retryable: boolean
  readonly reason: string
}> {
  override get message(): string {
    return `HydraDB engine failure (${this.code}): ${this.reason}`
  }
}

export class HydraParseError extends Data.TaggedError("HydraParseError")<{
  readonly reason: string
  readonly code: string
  readonly query: string
}> {
  override get message(): string {
    return `HydraDB rejected the statement: ${this.reason}`
  }
}

/** A server-side cap was hit: body size, runtime, result vertices, rate limit. */
export class HydraLimitError extends Data.TaggedError("HydraLimitError")<{
  readonly reason: string
  readonly status: number
  readonly query: string
}> {
  override get message(): string {
    return `HydraDB refused the statement on a limit: ${this.reason}`
  }
}

/** Transport failure, 5xx, or an unparseable response. */
export class HydraUnavailable extends Data.TaggedError("HydraUnavailable")<{
  readonly reason: string
  readonly status?: number
  readonly cause?: unknown
}> {
  override get message(): string {
    return `HydraDB is unavailable: ${this.reason}`
  }
}

export class HydraIdentityIntegrityError extends Data.TaggedError("HydraIdentityIntegrityError")<{
  readonly kind: "relationship" | "vertex"
  readonly reason: "missingFullKey" | "numericCollision" | "numericMismatch"
  readonly numericId: number
  /** SHA-256 fingerprints only: no tenant/user key material may cross this seam. */
  readonly existingKeyFingerprint: string | null
  readonly requestedKeyFingerprint: string
}> {
  override get message(): string {
    return `Hydra ${this.kind} identity integrity failure: ${this.reason} for numeric id ${this.numericId}`
  }
}

export type HydraError =
  | HydraEngineError
  | HydraIdentityIntegrityError
  | HydraParseError
  | HydraLimitError
  | HydraUnavailable
