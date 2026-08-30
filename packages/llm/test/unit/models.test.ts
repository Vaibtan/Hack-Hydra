import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
  UnknownModelError,
  distinctIds,
  readPathModels,
  unknownIds,
  verifyModelsAtStartup
} from "../../src/index.js"

/**
 * The check exists to turn a typo into a one-line failure instead of a
 * five-hour run that produces a table of provider errors — or, on a provider
 * that silently substitutes, a table of real numbers from a model nobody chose.
 * So the message is the feature, and it is tested.
 */

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
    // The reader is frozen for the whole v1-vs-v2 comparison: v1's numbers were
    // measured with it, and changing it would make every paired result a
    // comparison of two things at once.
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

  it("verifies each distinct id once, not once per call site", () => {
    const models = { reader: "a", select: "a", sufficiency: "b" }
    expect(distinctIds(models)).toEqual(["a", "b"])
    // The judge is a fourth id and belongs in the same check: a run whose judge
    // id is wrong fails after every answer has been paid for.
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

/**
 * The async form. `withEnv` restores in a `finally` that runs as soon as the
 * body *returns*, which for an async body is before it has done anything — so
 * an async test using it would read whatever environment the file happened to
 * leave behind and pass for the wrong reason.
 */
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
  /**
   * The seam that matters is `verifyModels`, which is tested above. What
   * `verifyModelsAtStartup` adds is the *decision*: exit on an unknown id,
   * proceed on an unreachable provider. Both are asserted against a stubbed
   * `/models` endpoint and a stubbed `process.exit`, because the difference
   * between them is the whole reason the check is safe to put in front of a
   * server.
   */
  const withStubbedExit = async (body: () => Promise<void>): Promise<Array<number>> => {
    const codes: Array<number> = []
    const realExit = process.exit
    // A real exit would take the test runner with it; the code is what is asserted.
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

  it("exits 2 on an id the provider does not list", async () => {
    const codes = await withEnvAsync(
      {
        OPENAI_API_KEY: "test-key",
        OPENAI_BASE_URL: "https://provider.invalid/v1",
        PALIMPSEST_MODEL: "gpt-5.6-luna",
        PALIMPSEST_SELECT_MODEL: "gpt-5.6-lunar",
        PALIMPSEST_SUFFICIENCY_MODEL: undefined
      },
      () =>
        withStubbedExit(() =>
          withStubbedFetch({ ok: true, ids: ["gpt-5.6-luna", "gpt-4o"] }, () =>
            Effect.runPromise(verifyModelsAtStartup({ quiet: true }))
          )
        )
    )

    expect(codes).toEqual([2])
  })

  it("proceeds when the provider cannot be reached", async () => {
    // An unrelated outage must not look like a configuration error.
    const codes = await withEnvAsync(
      {
        OPENAI_API_KEY: "test-key",
        OPENAI_BASE_URL: "https://provider.invalid/v1",
        PALIMPSEST_MODEL: "gpt-5.6-luna",
        PALIMPSEST_SELECT_MODEL: undefined,
        PALIMPSEST_SUFFICIENCY_MODEL: undefined
      },
      () =>
        withStubbedExit(() =>
          withStubbedFetch({ ok: false }, () =>
            Effect.runPromise(verifyModelsAtStartup({ quiet: true }))
          )
        )
    )

    expect(codes).toEqual([])
  })

  it("proceeds when every configured id is listed", async () => {
    const codes = await withEnvAsync(
      {
        OPENAI_API_KEY: "test-key",
        OPENAI_BASE_URL: "https://provider.invalid/v1",
        PALIMPSEST_MODEL: "gpt-5.6-luna",
        PALIMPSEST_SELECT_MODEL: "gpt-4o-mini",
        PALIMPSEST_SUFFICIENCY_MODEL: undefined
      },
      () =>
        withStubbedExit(() =>
          withStubbedFetch({ ok: true, ids: ["gpt-5.6-luna", "gpt-4o-mini"] }, () =>
            Effect.runPromise(verifyModelsAtStartup({ quiet: true }))
          )
        )
    )

    expect(codes).toEqual([])
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
