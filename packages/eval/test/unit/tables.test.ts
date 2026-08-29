import { describe, expect, it } from "vitest"
import {
  errorClass,
  mcnemarExact,
  paired,
  pairedDifferenceCi,
  type PairedTable
} from "../../src/Tables.js"
import type { EvalRow } from "../../src/Results.js"

/**
 * The arithmetic is pinned to the 2026-08-20 evidence audit, which computed it
 * by hand. If `pnpm table` and the audit ever disagree, one of them is wrong and
 * this test says which.
 */
const AUDIT: PairedTable = { both: 38, leftOnly: 5, rightOnly: 3, neither: 8, n: 54 }

describe("exact McNemar", () => {
  it("reproduces the audit's palimpsest-vs-bm25 p", () => {
    // 2 * P(Binomial(8, 0.5) <= 3) = 2 * 93/256
    expect(mcnemarExact(AUDIT.leftOnly, AUDIT.rightOnly)).toBeCloseTo(0.7265625, 12)
  })

  it("reproduces the audit's fullctx comparison (4 vs 2 discordant)", () => {
    expect(mcnemarExact(2, 4)).toBeCloseTo(0.6875, 12)
  })

  it("is 1 when nothing is discordant, and symmetric", () => {
    expect(mcnemarExact(0, 0)).toBe(1)
    expect(mcnemarExact(7, 2)).toBeCloseTo(mcnemarExact(2, 7), 15)
  })

  it("is never above 1 for an even, evenly split discordance", () => {
    expect(mcnemarExact(1, 1)).toBeLessThanOrEqual(1)
    expect(mcnemarExact(5, 5)).toBeLessThanOrEqual(1)
  })

  it("stays exact at a size the chi-square approximation would be used for", () => {
    // 2 * P(Binomial(30, .5) <= 10), as an exact rational: the point of the
    // exact form is that this number does not depend on an approximation.
    expect(mcnemarExact(20, 10)).toBeCloseTo((2 * 53_009_102) / 2 ** 30, 15)
  })
})

describe("paired difference interval", () => {
  it("reproduces the audit's +3.70 pp and its -6.61 to +14.02 interval", () => {
    const ci = pairedDifferenceCi(AUDIT)
    expect(ci.points).toBeCloseTo(3.7037, 3)
    expect(ci.lowPoints).toBeCloseTo(-6.61, 2)
    expect(ci.highPoints).toBeCloseTo(14.02, 2)
  })

  it("is a point with no questions", () => {
    expect(pairedDifferenceCi({ both: 0, leftOnly: 0, rightOnly: 0, neither: 0, n: 0 }).points).toBe(0)
  })
})

const row = (over: Partial<EvalRow>): EvalRow => ({
  system: "palimpsest",
  questionId: "q",
  questionType: "multi-session",
  isAbstention: false,
  verdict: "ANSWER",
  reason: null,
  answer: "",
  notInMemory: false,
  premiseSupported: null,
  premiseNote: "",
  judged: false,
  judgeTemplate: "default",
  judgeReply: "No",
  judgeModel: "gpt-4o",
  evidenceSessions: [],
  answerSessions: ["a"],
  sessionHit: false,
  evidence: 0,
  anchorsAsked: 0,
  anchorsReachingClaims: 0,
  readerInputTokens: 0,
  readerOutputTokens: 0,
  sessionsDropped: 0,
  latencyMs: 0,
  hash: "",
  ...over
})

describe("pairing", () => {
  it("counts only the answerable questions both systems ran", () => {
    const left = [
      row({ questionId: "1", judged: true }),
      row({ questionId: "2", judged: false }),
      row({ questionId: "3", judged: true, isAbstention: true }),
      row({ questionId: "4", judged: true })
    ]
    const right = [
      row({ questionId: "1", judged: true }),
      row({ questionId: "2", judged: true }),
      row({ questionId: "3", judged: false, isAbstention: true })
    ]
    const result = paired(left, right)
    expect(result).toMatchObject({ n: 2, both: 1, leftOnly: 0, rightOnly: 1, neither: 0 })
  })
})

describe("error class", () => {
  it("is null when the judge scored the row correct", () => {
    expect(errorClass(row({ judged: true }))).toBeNull()
  })

  it("calls an incorrect _abs question a premise failure", () => {
    expect(errorClass(row({ isAbstention: true }))).toBe("premise")
  })

  it("uses the candidate union when v2 recorded one", () => {
    expect(errorClass({ ...row({ sessionHit: true }), unionSessions: ["b"] })).toBe("retrieval_miss")
    expect(
      errorClass({ ...row({}), unionSessions: ["a"], keptSessions: [], budgetDroppedSessions: [] })
    ).toBe("selection")
    expect(
      errorClass({
        ...row({}),
        unionSessions: ["a"],
        keptSessions: ["a"],
        budgetDroppedSessions: ["a"]
      })
    ).toBe("packing")
    expect(
      errorClass({ ...row({}), unionSessions: ["a"], keptSessions: ["a"], budgetDroppedSessions: [] })
    ).toBe("reader")
  })

  it("falls back to the surviving evidence for a v1 row, which records no union", () => {
    expect(errorClass(row({ sessionHit: false }))).toBe("retrieval_miss")
    expect(errorClass(row({ sessionHit: true }))).toBe("reader")
  })
})
