import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { SlotChainResponse } from "../../src/index.js"

const source = {
  sourceDigest: "a".repeat(64),
  logicalSessionId: "session-a",
  sid: "session-a",
  turnIdx: 1,
  offsetStart: 9,
  offsetEnd: 22,
  speaker: "user",
  excerpt: "I moved to Pune last week.",
  highlight: { start: 8, end: 22 }
}

describe("slot-chain public contract", () => {
  it("requires a derived assertion to carry a verbatim source span", () => {
    const decode = Schema.decodeUnknownResult(SlotChainResponse)
    const result = decode({
      skey: "user-a|s|user|residence",
      asOf: null,
      assertions: [
        {
          assertionKey: "user-a|c|assertion-a",
          derivedText: "The user moved to Pune.",
          sessionOrd: 3,
          tEvent: 20260820,
          sid: "session-a",
          source,
          supersededBy: null,
          atSession: null
        }
      ]
    })

    expect(result).toMatchObject({
      _tag: "Success",
      success: {
        assertions: [
          {
            derivedText: "The user moved to Pune.",
            source: { sourceDigest: "a".repeat(64), offsetStart: 9, offsetEnd: 22 }
          }
        ]
      }
    })
  })

  it("rejects the legacy claims/text response shape that made model output look like evidence", () => {
    const decode = Schema.decodeUnknownResult(SlotChainResponse)
    const result = decode({
      skey: "user-a|s|user|residence",
      asOf: null,
      claims: [
        {
          ckey: "user-a|c|assertion-a",
          text: "The user moved to Pune.",
          sessionOrd: 3,
          tEvent: 20260820,
          sid: "session-a",
          supersededBy: null,
          atSession: null
        }
      ]
    })

    expect(result._tag).toBe("Failure")
  })
})
