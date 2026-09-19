import { AiError } from "effect/unstable/ai"
import { Effect, Schedule } from "effect"
import { describe, expect, it } from "vitest"
import { isTransient } from "../../src/Llm.js"

const request = {
  method: "POST" as const,
  url: "https://provider.invalid/v1/chat/completions",
  urlParams: [],
  headers: {}
}

const status = (code: number): AiError.AiError => {
  const reason = code === 429
    ? new AiError.RateLimitError({})
    : code >= 500
      ? new AiError.InternalProviderError({ description: `HTTP ${code}` })
      : new AiError.InvalidRequestError({ description: `HTTP ${code}` })
  return new AiError.AiError({
    module: "OpenAiClient",
    method: "createChatCompletion",
    reason
  })
}

const transport = (): AiError.AiError =>
  new AiError.AiError({
    module: "OpenAiClient",
    method: "createChatCompletion",
    reason: new AiError.NetworkError({ request, reason: "TransportError" })
  })

const malformed = (): AiError.AiError =>
  new AiError.AiError({
    module: "OpenAiClient",
    method: "generateObject",
    reason: new AiError.InvalidOutputError({ description: "bad json" })
  })

const attempts = (error: AiError.AiError): Promise<number> => {
  let calls = 0
  return Effect.runPromise(
    Effect.suspend(() => {
      calls++
      return Effect.fail(error)
    }).pipe(
      Effect.retry({ schedule: Schedule.recurs(3), while: isTransient }),
      Effect.result,
      Effect.map(() => calls)
    )
  )
}

describe("provider retries", () => {
  it("retries a 429 and a 5xx", async () => {
    expect(isTransient(status(429))).toBe(true)
    expect(isTransient(status(503))).toBe(true)
    expect(await attempts(status(429))).toBe(4)
  })

  it("retries a transport failure", async () => {
    expect(isTransient(transport())).toBe(true)
    expect(await attempts(transport())).toBe(4)
  })

  it("does not retry a 400, which is the same answer on every attempt", async () => {
    expect(isTransient(status(400))).toBe(false)
    expect(await attempts(status(400))).toBe(1)
  })

  it("retries a malformed output, since the model is stochastic", async () => {
    expect(isTransient(malformed())).toBe(true)
    expect(await attempts(malformed())).toBeGreaterThan(1)
  })
})
