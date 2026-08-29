import { Either } from "effect"
import { describe, expect, it } from "vitest"
import { contentAddressedId } from "../../src/Client.js"
import { edgeId, verifyStoredGraphIdentity, vertexId } from "../../src/Ids.js"

/**
 * A relationship has two ids on the wire and only one of them is ours.
 *
 * `algo.MSpaths` returns the engine's own relationship identity — a small
 * counter, `1145` for the first `HAS_TURN` of a fresh graph — while the
 * content-addressed `edgeId` this client wrote lives in the `id` *property*,
 * because the engine refuses `SET r.id`. Verifying the wrong one compares a
 * counter with a hash, which fails on every path that carries an edge; that is
 * every path retrieval reads, so an ingest died at its first supersession pass
 * with `numericMismatch for numeric id 19995`.
 *
 * Vertices do not have the problem: `node.id` *is* the content-addressed id
 * (measured against a live node: `2364642823230` for the Session key below).
 */

const SRC = "g3-0e5e2d1a|sess|2e53d65e_3"
const DST = "g3-0e5e2d1a|turn|2e53d65e_3|11"
const FULL_KEY = `${SRC}|HAS_TURN|${DST}`
/** What the engine actually returned for this edge. */
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
    expect(Either.isRight(outcome)).toBe(true)
  })

  it("rejects the engine's own relationship id, which is what the bug compared", () => {
    const outcome = verifyStoredGraphIdentity({
      kind: "relationship",
      numericId: ENGINE_RELATIONSHIP_ID,
      requestedKey: FULL_KEY,
      storedKey: FULL_KEY
    })
    expect(Either.isLeft(outcome)).toBe(true)
    if (Either.isLeft(outcome)) expect(outcome.left.reason).toBe("numericMismatch")
  })

  it("treats a missing id property as a mismatch rather than a pass", () => {
    const outcome = verifyStoredGraphIdentity({
      kind: "relationship",
      numericId: contentAddressedId({ __palimpsest_full_key: FULL_KEY }),
      requestedKey: FULL_KEY,
      storedKey: FULL_KEY
    })
    expect(Either.isLeft(outcome)).toBe(true)
  })

  it("still reports an edge with no stored full key", () => {
    const outcome = verifyStoredGraphIdentity({
      kind: "relationship",
      numericId: contentAddressedId({ id: edgeId(SRC, "HAS_TURN", DST) }),
      requestedKey: "",
      storedKey: null
    })
    expect(Either.isLeft(outcome)).toBe(true)
    if (Either.isLeft(outcome)) expect(outcome.left.reason).toBe("missingFullKey")
  })
})
