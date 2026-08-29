import { describe, expect, it } from "vitest"
import { classifyHydraHttpError, HydraEngineError } from "../../src/index.js"

describe("classifyHydraHttpError", () => {
  it("preserves reviewed engine codes as typed, safe failures", () => {
    const failure = classifyHydraHttpError(
      503,
      {
        error: {
          code: "object_store_unavailable",
          message: "an internal bucket endpoint must never leave this process"
        }
      },
      "MATCH (n) RETURN n"
    )

    expect(failure).toBeInstanceOf(HydraEngineError)
    expect(failure).toMatchObject({
      _tag: "HydraEngineError",
      code: "object_store_unavailable",
      status: 503,
      retryable: true,
      query: "MATCH (n) RETURN n"
    })
    expect(failure.message).not.toContain("bucket")
    expect(failure.message).not.toContain("endpoint")
  })

  it("keeps an idempotency conflict distinct from a retryable outage", () => {
    const failure = classifyHydraHttpError(
      409,
      { error: { code: "idempotency_conflict", message: "request id: internal-value" } },
      "MERGE (n)"
    )

    expect(failure).toMatchObject({
      _tag: "HydraEngineError",
      code: "idempotency_conflict",
      status: 409,
      retryable: false
    })
    expect(failure.message).not.toContain("internal-value")
  })

  it("does not trust unknown 5xx response text", () => {
    const failure = classifyHydraHttpError(
      500,
      { error: { code: "internal", message: "timeout stack trace with backend details" } },
      "MATCH (n)"
    )

    expect(failure._tag).toBe("HydraUnavailable")
    expect(failure.message).not.toContain("timeout stack trace")
  })
})
