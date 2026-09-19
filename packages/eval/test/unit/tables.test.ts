import { describe, expect, it } from "vitest"
import {
  errorClass,
  mcnemarExact,
  paired,
  pairedDifferenceCi,
  renderAblations,
  renderLatency,
  type PairedTable
} from "../../src/Tables.js"
import type { EvalRow } from "../../src/Envelope.js"

const AUDIT: PairedTable = { both: 38, leftOnly: 5, rightOnly: 3, neither: 8, n: 54 }

describe("exact McNemar", () => {
  it("reproduces the audit's palimpsest-vs-bm25 p", () => {
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

describe("latency table", () => {
  it("shows a dash where a row recorded nothing, because zero is a measurement", () => {
    const table = renderLatency([
      ["bm25", [row({ readerInputTokens: 4000 }), row({ readerInputTokens: 6000 })]]
    ])
    expect(table).toContain("| bm25 | — | — | — | — |")
  })

  it("reports p50 and p90 separately, so a long tail is visible", () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => row({ questionId: `f${i}`, askMs: 3000, graphMs: 100 })),
      ...Array.from({ length: 4 }, (_, i) => row({ questionId: `s${i}`, askMs: 40_000, graphMs: 100 }))
    ]
    const table = renderLatency([["palimpsest-v2", rows]])
    expect(table).toContain("| palimpsest-v2 | 100 ms | 100 ms | 3.0 s | 40.0 s |")
  })

  it("prints sub-second latency in ms and anything longer in seconds", () => {
    const table = renderLatency([["palimpsest-v2", [row({ graphMs: 68, askMs: 1500 })]]])
    expect(table).toContain("68 ms")
    expect(table).toContain("1.5 s")
  })

  it("thousands-separates reader tokens, which are read as a budget", () => {
    const table = renderLatency([["fullctx", [row({ readerInputTokens: 128_000 })]]])
    expect(table).toContain("128,000")
  })

  it("renders one row per system, in the order given", () => {
    const table = renderLatency([
      ["palimpsest", [row({})]],
      ["palimpsest-v2", [row({})]]
    ])
    const lines = table.split("\n").slice(2)
    expect(lines.map((line) => line.split("|")[1]!.trim())).toEqual(["palimpsest", "palimpsest-v2"])
  })
})

describe("ablation table", () => {
  const answerable = (id: string, judged: boolean, askMs?: number): EvalRow =>
    row({ questionId: id, judged, ...(askMs !== undefined && { askMs }) })

  const full = [
    answerable("1", true, 5000),
    answerable("2", true, 5000),
    answerable("3", false, 5000),
    row({ questionId: "abs", isAbstention: true, judged: true })
  ]

  it("says so plainly when there is nothing to compare", () => {
    expect(renderAblations(full, [])).toContain("No ablation runs")
  })

  it("scores against the answerable questions only", () => {
    const table = renderAblations(full, [
      { ablations: ["noSelect"], rows: [answerable("1", true), answerable("2", false), answerable("3", false), row({ questionId: "abs", isAbstention: true, judged: true })] }
    ])
    expect(table).toContain("correct of 3")
    expect(table).toContain("| _none (full plan)_ | 2 | — |")
    expect(table).toContain("| noSelect | 1 | -1 |")
  })

  it("reports a stage whose removal helped with the same emphasis as one that hurt", () => {
    const table = renderAblations(full, [
      { ablations: ["noDiscovery"], rows: [answerable("1", true), answerable("2", true), answerable("3", true)] }
    ])
    expect(table).toContain("| noDiscovery | 3 | +1 |")
  })

  it("orders the rows so two runs diff line for line", () => {
    const table = renderAblations(full, [
      { ablations: ["noTimeScope"], rows: [answerable("1", true)] },
      { ablations: ["noDecompose"], rows: [answerable("1", true)] }
    ])
    expect(table.indexOf("noDecompose")).toBeLessThan(table.indexOf("noTimeScope"))
  })

  it("names a combination of flags as one row", () => {
    const table = renderAblations(full, [
      { ablations: ["noDiscovery", "noSelect"], rows: [answerable("1", false)] }
    ])
    expect(table).toContain("| noDiscovery + noSelect |")
  })

  it("shows a dash for latency an ablation did not record", () => {
    const table = renderAblations(full, [{ ablations: ["noSelect"], rows: [answerable("1", true)] }])
    expect(table).toMatch(/\| noSelect \| 1 \| -1 \| — \|/)
  })
})
