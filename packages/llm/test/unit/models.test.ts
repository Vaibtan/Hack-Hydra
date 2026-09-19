import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
  DEFAULT_MODEL,
  UnknownModelError,
  configuredModel,
  distinctIds,
  readPathModels,
  resolveReadPathModels,
  unknownIds,
  verifyModelsAtStartup,
  verifyModelsOrExit
} from "../../src/Models.js"

const withEnv = <A>(env: Record<string, string | undefined>, body: () => A): A => {
  const before = new Map(Object.keys(env).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return body()
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

const CLEAN = {
  PALIMPSEST_MODEL: undefined,
  PALIMPSEST_SELECT_MODEL: undefined,
  PALIMPSEST_SUFFICIENCY_MODEL: undefined
}

describe("the read path's model ids", () => {
  it("defaults all three to the same model, so setting nothing is the frozen comparison", () => {
    const models = withEnv(CLEAN, () => readPathModels("gpt-5.6-luna"))
    expect(models).toEqual({
      reader: "gpt-5.6-luna",
      select: "gpt-5.6-luna",
      sufficiency: "gpt-5.6-luna"
    })
  })

  it("lets the selector move without moving the reader", () => {
    const models = withEnv({ ...CLEAN, PALIMPSEST_SELECT_MODEL: "gpt-4o" }, () =>
      readPathModels("gpt-5.6-luna")
    )
    expect(models.reader).toBe("gpt-5.6-luna")
    expect(models.select).toBe("gpt-4o")
    expect(models.sufficiency).toBe("gpt-5.6-luna")
  })

  it("follows PALIMPSEST_MODEL for the two that are not separately set", () => {
    const models = withEnv({ ...CLEAN, PALIMPSEST_MODEL: "gpt-4o" }, () =>
      readPathModels("gpt-5.6-luna")
    )
    expect(models).toEqual({ reader: "gpt-4o", select: "gpt-4o", sufficiency: "gpt-4o" })
  })

  it("treats an empty variable as unset, so the receipt names the model that actually ran", () => {
    const models = withEnv(
      { PALIMPSEST_MODEL: "", PALIMPSEST_SELECT_MODEL: "", PALIMPSEST_SUFFICIENCY_MODEL: "gpt-4o" },
      () => readPathModels("gpt-5.6-luna")
    )
    expect(models).toEqual({ reader: "gpt-5.6-luna", select: "gpt-5.6-luna", sufficiency: "gpt-4o" })
    expect(withEnv({ PALIMPSEST_SELECT_MODEL: "" }, () => configuredModel("PALIMPSEST_SELECT_MODEL"))).toBeUndefined()
  })

  it("resolves to DEFAULT_MODEL when no fallback is given", () => {
    expect(withEnv(CLEAN, () => resolveReadPathModels()).reader).toBe(DEFAULT_MODEL)
  })

  it("verifies each distinct id once, not once per call site", () => {
    const models = { reader: "a", select: "a", sufficiency: "b" }
    expect(distinctIds(models)).toEqual(["a", "b"])
    expect(distinctIds(models, ["gpt-4o"])).toEqual(["a", "b", "gpt-4o"])
  })
})

describe("what counts as unknown", () => {
  it("names every id the provider does not list, not just the first", () => {
    expect(unknownIds(["a", "b", "c"], ["b"])).toEqual(["a", "c"])
  })

  it("is empty when the provider lists them all", () => {
    expect(unknownIds(["a", "b"], ["a", "b", "c"])).toEqual([])
  })

  it("puts the unknown id and the fix in the message", () => {
    const error = new UnknownModelError(["gpt-5.6-lunar"], ["gpt-5.6-luna", "gpt-4o"])
    expect(error.message).toContain("gpt-5.6-lunar")
    expect(error.message).toContain("PALIMPSEST_MODEL")
    expect(error.message).toContain("gpt-5.6-luna")
  })

})

/** `withEnv` restores as soon as the body returns, which for an async body is before it has run. */
const withEnvAsync = async <A>(
  env: Record<string, string | undefined>,
  body: () => Promise<A>
): Promise<A> => {
  const before = new Map(Object.keys(env).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await body()
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

describe("the startup check", () => {
  const fetchResponse = (
    response: { readonly ok: boolean; readonly ids?: ReadonlyArray<string> }
  ): typeof fetch => async () =>
    new Response(JSON.stringify({ data: (response.ids ?? []).map((id) => ({ id })) }), {
      status: response.ok ? 200 : 503,
      headers: { "content-type": "application/json" }
    })

  const PROVIDER = {
    OPENAI_API_KEY: "test-key",
    OPENAI_BASE_URL: "https://provider.invalid/v1",
    PALIMPSEST_MODEL: "gpt-5.6-luna",
    PALIMPSEST_SUFFICIENCY_MODEL: undefined
  }

  it("fails with UnknownModelError on an id the provider does not list", async () => {
    const outcome = await withEnvAsync({ ...PROVIDER, PALIMPSEST_SELECT_MODEL: "gpt-5.6-lunar" }, () =>
      Effect.runPromise(Effect.result(verifyModelsAtStartup({
        quiet: true,
        fetch: fetchResponse({ ok: true, ids: ["gpt-5.6-luna", "gpt-4o"] })
      })))
    )
    expect(outcome._tag).toBe("Failure")
    if (outcome._tag === "Failure") {
      expect(outcome.failure).toBeInstanceOf(UnknownModelError)
      expect(outcome.failure.unknown).toEqual(["gpt-5.6-lunar"])
    }
  })

  it("exits 2 through the wrapper on an id the provider does not list", async () => {
    const codes: Array<number> = []
    await withEnvAsync({ ...PROVIDER, PALIMPSEST_SELECT_MODEL: "gpt-5.6-lunar" }, () =>
      Effect.runPromise(verifyModelsOrExit({
        quiet: true,
        fetch: fetchResponse({ ok: true, ids: ["gpt-5.6-luna", "gpt-4o"] }),
        exit: (code) => { codes.push(code) }
      }))
    )
    expect(codes).toEqual([2])
  })

  it("proceeds when the provider cannot be reached", async () => {
    await withEnvAsync({ ...PROVIDER, PALIMPSEST_SELECT_MODEL: undefined }, () =>
      Effect.runPromise(verifyModelsAtStartup({ quiet: true, fetch: fetchResponse({ ok: false }) }))
    )
  })

  it("proceeds when every configured id is listed", async () => {
    await withEnvAsync({ ...PROVIDER, PALIMPSEST_SELECT_MODEL: "gpt-4o-mini" }, () =>
      Effect.runPromise(verifyModelsAtStartup({
        quiet: true,
        fetch: fetchResponse({ ok: true, ids: ["gpt-5.6-luna", "gpt-4o-mini"] })
      }))
    )
  })

  it("does not call the provider at all without an api key", async () => {
    let called = false
    const fetchWithoutKey: typeof fetch = async () => {
      called = true
      return new Response(null, { status: 503 })
    }
    await withEnvAsync({ OPENAI_API_KEY: "" }, () =>
      Effect.runPromise(verifyModelsAtStartup({ quiet: true, fetch: fetchWithoutKey }))
    )

    expect(called).toBe(false)
  })
})
