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

  it("pluralises honestly, because a message that says 'ids: x' reads as a bug", () => {
    expect(new UnknownModelError(["x"], []).message).toContain("unknown model id:")
    expect(new UnknownModelError(["x", "y"], []).message).toContain("unknown model ids:")
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
  const withStubbedExit = async (body: () => Promise<void>): Promise<Array<number>> => {
    const codes: Array<number> = []
    const realExit = process.exit
    process.exit = ((code?: number) => {
      codes.push(code ?? 0)
      return undefined as never
    }) as typeof process.exit
    try {
      await body()
    } finally {
      process.exit = realExit
    }
    return codes
  }

  const withStubbedFetch = async <A>(
    response: { readonly ok: boolean; readonly ids?: ReadonlyArray<string> },
    body: () => Promise<A>
  ): Promise<A> => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => ({
      ok: response.ok,
      json: async () => ({ data: (response.ids ?? []).map((id) => ({ id })) })
    })) as unknown as typeof fetch
    try {
      return await body()
    } finally {
      globalThis.fetch = realFetch
    }
  }

  const PROVIDER = {
    OPENAI_API_KEY: "test-key",
    OPENAI_BASE_URL: "https://provider.invalid/v1",
    PALIMPSEST_MODEL: "gpt-5.6-luna",
    PALIMPSEST_SUFFICIENCY_MODEL: undefined
  }

  it("fails with UnknownModelError on an id the provider does not list", async () => {
    const outcome = await withEnvAsync({ ...PROVIDER, PALIMPSEST_SELECT_MODEL: "gpt-5.6-lunar" }, () =>
      withStubbedFetch({ ok: true, ids: ["gpt-5.6-luna", "gpt-4o"] }, () =>
        Effect.runPromise(Effect.either(verifyModelsAtStartup({ quiet: true })))
      )
    )
    expect(outcome._tag).toBe("Left")
    if (outcome._tag === "Left") {
      expect(outcome.left).toBeInstanceOf(UnknownModelError)
      expect(outcome.left.unknown).toEqual(["gpt-5.6-lunar"])
    }
  })

  it("exits 2 through the wrapper on an id the provider does not list", async () => {
    const codes = await withEnvAsync({ ...PROVIDER, PALIMPSEST_SELECT_MODEL: "gpt-5.6-lunar" }, () =>
      withStubbedExit(() =>
        withStubbedFetch({ ok: true, ids: ["gpt-5.6-luna", "gpt-4o"] }, () =>
          Effect.runPromise(verifyModelsOrExit({ quiet: true }))
        )
      )
    )
    expect(codes).toEqual([2])
  })

  it("proceeds when the provider cannot be reached", async () => {
    await withEnvAsync({ ...PROVIDER, PALIMPSEST_SELECT_MODEL: undefined }, () =>
      withStubbedFetch({ ok: false }, () => Effect.runPromise(verifyModelsAtStartup({ quiet: true })))
    )
  })

  it("proceeds when every configured id is listed", async () => {
    await withEnvAsync({ ...PROVIDER, PALIMPSEST_SELECT_MODEL: "gpt-4o-mini" }, () =>
      withStubbedFetch({ ok: true, ids: ["gpt-5.6-luna", "gpt-4o-mini"] }, () =>
        Effect.runPromise(verifyModelsAtStartup({ quiet: true }))
      )
    )
  })

  it("does not call the provider at all without an api key", async () => {
    let called = false
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      called = true
      return { ok: false, json: async () => ({}) } as unknown as Response
    }) as unknown as typeof fetch
    try {
      await withEnvAsync({ OPENAI_API_KEY: "" }, () =>
        Effect.runPromise(verifyModelsAtStartup({ quiet: true }))
      )
    } finally {
      globalThis.fetch = realFetch
    }

    expect(called).toBe(false)
  })
})
