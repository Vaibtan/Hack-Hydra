import { Result } from "effect"
import { describe, expect, it } from "vitest"
import { contentAddressedId } from "../../src/Identity.js"
import { edgeId, verifyStoredGraphIdentity, vertexId } from "../../src/Ids.js"

const SRC = "g3-0e5e2d1a|sess|2e53d65e_3"
const DST = "g3-0e5e2d1a|turn|2e53d65e_3|11"
const FULL_KEY = `${SRC}|HAS_TURN|${DST}`
/** The engine's own sequential id for this edge, as `algo.MSpaths` returned it. */
const ENGINE_RELATIONSHIP_ID = 1145

describe("relationship identity from a path", () => {
  it("reads the content-addressed id from the id property, not the engine's", () => {
    const properties = { __palimpsest_full_key: FULL_KEY, id: edgeId(SRC, "HAS_TURN", DST) }
    expect(contentAddressedId(properties)).toBe(vertexId(FULL_KEY))
    expect(contentAddressedId(properties)).not.toBe(ENGINE_RELATIONSHIP_ID)
  })

  it("accepts an edge whose id property matches its stored full key", () => {
    const outcome = verifyStoredGraphIdentity({
      kind: "relationship",
      numericId: contentAddressedId({ id: edgeId(SRC, "HAS_TURN", DST) }),
      requestedKey: FULL_KEY,
      storedKey: FULL_KEY
    })
    expect(Result.isSuccess(outcome)).toBe(true)
  })

  it("rejects the engine's own relationship id, which is what the bug compared", () => {
    const outcome = verifyStoredGraphIdentity({
      kind: "relationship",
      numericId: ENGINE_RELATIONSHIP_ID,
      requestedKey: FULL_KEY,
      storedKey: FULL_KEY
    })
    expect(Result.isFailure(outcome)).toBe(true)
    if (Result.isFailure(outcome)) expect(outcome.failure.reason).toBe("numericMismatch")
  })

  it("treats a missing id property as a mismatch rather than a pass", () => {
    const outcome = verifyStoredGraphIdentity({
      kind: "relationship",
      numericId: contentAddressedId({ __palimpsest_full_key: FULL_KEY }),
      requestedKey: FULL_KEY,
      storedKey: FULL_KEY
    })
    expect(Result.isFailure(outcome)).toBe(true)
  })

  it("still reports an edge with no stored full key", () => {
    const outcome = verifyStoredGraphIdentity({
      kind: "relationship",
      numericId: contentAddressedId({ id: edgeId(SRC, "HAS_TURN", DST) }),
      requestedKey: "",
      storedKey: null
    })
    expect(Result.isFailure(outcome)).toBe(true)
    if (Result.isFailure(outcome)) expect(outcome.failure.reason).toBe("missingFullKey")
  })
})
