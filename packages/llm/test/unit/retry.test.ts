import { AiError } from "@effect/ai"
import { Effect, Option, Schedule } from "effect"
import { describe, expect, it } from "vitest"
import { isTransient } from "../../src/Llm.js"

const request = {
  method: "POST" as const,
  url: "https://provider.invalid/v1/chat/completions",
  urlParams: [],
  hash: Option.none(),
  headers: {}
}

const status = (code: number): AiError.AiError =>
  new AiError.HttpResponseError({
    module: "OpenAiClient",
    method: "createChatCompletion",
    request,
    response: { status: code, headers: {} },
    reason: "StatusCode"
  })

const transport = (): AiError.AiError =>
  new AiError.HttpRequestError({
    module: "OpenAiClient",
    method: "createChatCompletion",
    request,
    reason: "Transport"
  })

const malformed = (): AiError.AiError =>
  new AiError.MalformedOutput({ module: "OpenAiClient", method: "generateObject", description: "bad json" })

const attempts = (error: AiError.AiError): Promise<number> => {
  let calls = 0
  return Effect.runPromise(
    Effect.suspend(() => {
      calls++
      return Effect.fail(error)
    }).pipe(
      Effect.retry({ schedule: Schedule.recurs(3), while: isTransient }),
      Effect.either,
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
