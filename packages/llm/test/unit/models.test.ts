import { describe, expect, it } from "vitest"
import { UnknownModelError, distinctIds, readPathModels, unknownIds } from "../../src/index.js"

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
