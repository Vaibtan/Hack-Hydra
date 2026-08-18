import { Data } from "effect"

/**
 * HydraDB's parse errors are precise — they name the exact rule you broke — so
 * they are carried through verbatim in `reason` rather than being reworded.
 */
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
  readonly cause?: unknown
}> {
  override get message(): string {
    return `HydraDB is unavailable: ${this.reason}`
  }
}

export type HydraError = HydraParseError | HydraLimitError | HydraUnavailable
