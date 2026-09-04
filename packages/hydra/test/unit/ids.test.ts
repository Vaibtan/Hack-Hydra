import { describe, expect, it } from "vitest"
import {
  createGraphIdentityRegistry,
  verifyStoredGraphIdentity,
  vertexId
} from "../../src/Ids.js"

/** Oracle: SHA-256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad; a vertex id is its top 53 bits. */
const SHA256_ABC_FIRST_8_BYTES = "ba7816bf8f01cfea"

describe("vertexId", () => {
  it("is the top 53 bits of the key's SHA-256 digest", () => {
    const expected = Number(BigInt(`0x${SHA256_ABC_FIRST_8_BYTES}`) >> 11n)
    expect(vertexId("abc")).toBe(expected)
  })

  it("is a non-negative safe integer for realistic keys", () => {
    for (const key of ["q1|c|deadbeef", "q1|t|hamster", "q1|sess|s_42", "", "ünïcödé|e|café"]) {
      const id = vertexId(key)
      expect(Number.isSafeInteger(id)).toBe(true)
      expect(id).toBeGreaterThanOrEqual(0)
    }
  })

  it("is deterministic and separates distinct keys", () => {
    expect(vertexId("q1|e|hamster")).toBe(vertexId("q1|e|hamster"))
    expect(vertexId("q1|e|hamster")).not.toBe(vertexId("q2|e|hamster"))
    expect(vertexId("q1|e|hamster")).not.toBe(vertexId("q1|e|hamsters"))
  })
})

describe("GraphIdentityRegistry", () => {
  it("fails closed when an injected numeric-id collision names a different full vertex key", () => {
    const identities = createGraphIdentityRegistry(() => 7)

    expect(identities.claimVertex("tenant-a|user")).toMatchObject({ _tag: "Right" })
    const collision = identities.claimVertex("tenant-b|user")

    expect(collision).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "HydraIdentityIntegrityError",
        kind: "vertex",
        reason: "numericCollision",
        numericId: 7
      }
    })
    if (collision._tag === "Left") {
      expect(collision.left.existingKeyFingerprint).toMatch(/^[a-f0-9]{64}$/)
      expect(collision.left.requestedKeyFingerprint).toMatch(/^[a-f0-9]{64}$/)
      expect(collision.left.message).not.toContain("tenant-a")
      expect(collision.left.message).not.toContain("tenant-b")
    }
  })

  it("rejects a persisted full key that differs from the requested key at the same numeric id", () => {
    const result = verifyStoredGraphIdentity({
      kind: "vertex",
      numericId: 7,
      requestedKey: "tenant-a|user",
      storedKey: "tenant-b|user",
      numericIdForKey: () => 7
    })

    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "HydraIdentityIntegrityError",
        kind: "vertex",
        reason: "numericCollision",
        numericId: 7
      }
    })
  })

  it("fails closed when a legacy record lacks its full-key witness", () => {
    const result = verifyStoredGraphIdentity({
      kind: "relationship",
      numericId: 7,
      requestedKey: "tenant-a|FOLLOWS|tenant-b",
      storedKey: null,
      numericIdForKey: () => 7
    })

    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "HydraIdentityIntegrityError",
        kind: "relationship",
        reason: "missingFullKey",
        numericId: 7,
        existingKeyFingerprint: null
      }
    })
  })
})
