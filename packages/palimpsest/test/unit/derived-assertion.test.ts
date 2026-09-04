import { describe, expect, it } from "vitest"
import { prepareDerivedIndexAssertions } from "../../src/DerivedAssertion.js"
import type { HydratedSpan } from "../../src/Reader.js"
import type { ChainClaim } from "../../src/Supersede.js"

const claim = (overrides: Partial<ChainClaim> = {}): ChainClaim => ({
  ckey: "user-a|c|assertion-a",
  text: "The user moved to Pune.",
  sessionOrd: 3,
  tEvent: 20260820,
  sid: "session-a",
  speaker: "user",
  ctype: "fact",
  sessionDate: 20260820,
  tPrec: "day",
  turnIdx: 1,
  cs: 9,
  ce: 22,
  sourceDigest: "a".repeat(64),
  sourceLogicalSessionId: "session-a",
  supersededBy: null,
  atSession: null,
  ...overrides
})

const sourceSpan = (overrides: Partial<HydratedSpan> = {}): HydratedSpan => ({
  ckey: "user-a|c|assertion-a",
  id: "sertion-a",
  sid: "session-a",
  sessionKey: "session-a",
  turnIdx: 2,
  cs: 0,
  ce: 0,
  sessionOrd: 3,
  sessionDate: 20260820,
  tEvent: 20260820,
  speaker: "user",
  status: "CURRENT",
  atSession: null,
  excerpt: "I moved to Pune last week.",
  highlight: { start: 8, end: 22 },
  ...overrides
})

describe("prepareDerivedIndexAssertions", () => {
  it("labels model output as a derived assertion and attaches its verbatim source span", () => {
    const result = prepareDerivedIndexAssertions([claim()], [sourceSpan()])

    expect(result).toMatchObject({
      _tag: "Right",
      right: [
        {
          assertionKey: "user-a|c|assertion-a",
          derivedText: "The user moved to Pune.",
          sessionOrd: 3,
          tEvent: 20260820,
          sid: "session-a",
          supersededBy: null,
          atSession: null,
          source: {
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
        }
      ]
    })
  })

  it("refuses to expose an assertion that cannot name its source revision", () => {
    const result = prepareDerivedIndexAssertions([claim({ sourceDigest: "" })], [sourceSpan()])

    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "DerivedAssertionSourceUnavailable",
        reason: "sourceRevisionUnavailable"
      }
    })
  })

  it("refuses to expose an assertion when its verbatim source span cannot be hydrated", () => {
    const result = prepareDerivedIndexAssertions([claim()], [])

    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "DerivedAssertionSourceUnavailable",
        reason: "sourceSpanUnavailable"
      }
    })
  })
})
