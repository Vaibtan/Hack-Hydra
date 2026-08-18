import { describe, expect, it } from "vitest"
import { vertexId } from "../../src/index.js"

/**
 * Oracle: the published SHA-256 digest of "abc" is
 *   ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
 * A vertex id is the top 53 bits of that digest, so it is a safe JS integer
 * (HydraDB node ids travel as JSON numbers, which cannot carry a full u64).
 */
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
