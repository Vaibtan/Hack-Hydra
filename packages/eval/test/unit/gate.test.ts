import { describe, expect, it } from "vitest"
import {
  GATE_BOUNDS,
  falseAbstentions,
  gateRefusals,
  overwriteRefusal,
  readGate,
  renderGate,
  worstTypeRegression,
  type EvalRow
} from "../../src/index.js"

/**
 * A gate chosen after seeing the numbers is not a gate, it is a description of
 * the numbers. These tests are about the *shape* of the decision — that it is a
 * conjunction, that an unmeasured bound fails, that an aggregate cannot hide a
 * broken type — not about any particular result.
 */

const row = (overrides: Partial<EvalRow> = {}): EvalRow => ({
  system: "palimpsest-v2",
  questionId: "q",
  questionType: "single-session-user",
  isAbstention: false,
  verdict: "ANSWER",
  reason: null,
  answer: "yes",
  notInMemory: false,
  premiseSupported: null,
  premiseNote: "",
  judged: true,
  judgeTemplate: "default",
  judgeReply: "yes",
  judgeModel: "gpt-4o",
  evidenceSessions: [],
  answerSessions: [],
  sessionHit: true,
  evidence: 3,
  anchorsAsked: 5,
  anchorsReachingClaims: 4,
  readerInputTokens: 2000,
  readerOutputTokens: 40,
  sessionsDropped: 0,
  latencyMs: 1000,
  hash: "h",
  graphMs: 400,
  ...overrides
})

const many = (n: number, overrides: Partial<EvalRow> = {}): Array<EvalRow> =>
  Array.from({ length: n }, (_, i) => row({ questionId: `q${i}`, ...overrides }))

describe("the gate is a conjunction", () => {
  it("passes only when every criterion passes", () => {
    const v1 = many(54, { judged: false })
    const v2 = many(54, { judged: true })
    const report = readGate(v1, v2)
    expect(report.passed).toBe(true)
    expect(report.criteria.every((criterion) => criterion.passed)).toBe(true)
  })

  it("fails the whole gate on one failing criterion, and names it", () => {
    // Five of six clear. A gate that reported "mostly passed" would be a
    // description of the numbers rather than a decision about them.
    const v1 = many(54, { judged: false })
    const v2 = many(54, { judged: true, readerInputTokens: 20_000 })
    const report = readGate(v1, v2)
    expect(report.passed).toBe(false)
    expect(report.criteria.filter((criterion) => !criterion.passed)).toHaveLength(1)
    expect(renderGate(report)).toContain("reader input tokens p50")
    expect(renderGate(report)).toContain("The test split stays unread.")
  })

  it("fails a bound it could not measure rather than skipping it", () => {
    // A results file with no `graphMs` -- an older file, or one written by a
    // run that crashed before timings landed -- must not pass the latency
    // criterion by default. An unmeasured bound is not a satisfied one.
    const v1 = many(54, { judged: false })
    const v2 = many(54, { judged: true }).map((r) => {
      const { graphMs: _dropped, ...rest } = r
      return rest
    })
    const report = readGate(v1, v2)
    expect(report.passed).toBe(false)
    expect(report.numbers["graphMsP50"]).toBeNull()
    expect(renderGate(report)).toContain("not measured")
  })
})

describe("what the aggregate must not hide", () => {
  it("catches a type that got worse even when the total improved", () => {
    // +4 on multi-session, -3 on knowledge-update is +1 overall and a broken
    // feature: knowledge-update is the question type the supersession graph
    // exists for.
    const v1 = [
      ...many(6, { questionType: "multi-session", judged: false }),
      ...many(6, { questionType: "knowledge-update", judged: true })
    ]
    const v2 = [
      ...many(6, { questionType: "multi-session", judged: true }).slice(0, 4),
      ...many(2, { questionType: "multi-session", judged: false }),
      ...many(3, { questionType: "knowledge-update", judged: true }),
      ...many(3, { questionType: "knowledge-update", judged: false })
    ]
    const worst = worstTypeRegression(v1, v2)
    expect(worst.type).toBe("knowledge-update")
    expect(worst.delta).toBe(-3)
    expect(readGate(v1, v2).passed).toBe(false)
  })

  it("allows a single-question regression, which is noise at this sample size", () => {
    expect(GATE_BOUNDS.maxTypeRegression).toBe(1)
    const v1 = many(4, { questionType: "temporal-reasoning", judged: true })
    const v2 = [
      ...many(3, { questionType: "temporal-reasoning", judged: true }),
      row({ questionType: "temporal-reasoning", judged: false })
    ]
    expect(worstTypeRegression(v1, v2).delta).toBe(-1)
  })
})

describe("false abstention", () => {
  it("counts a structural ABSENT and a reader refusal the same", () => {
    // From the asker's side they are one event: the system declined. A gate
    // that counted only one could be passed by moving refusals between the two
    // mechanisms.
    const rows = [
      row({ verdict: "ABSENT", reason: "A2_no_convergence" }),
      row({ notInMemory: true }),
      row()
    ]
    expect(falseAbstentions(rows)).toBe(2)
  })

  it("never counts an `_abs` question, where refusing is correct", () => {
    expect(falseAbstentions([row({ isAbstention: true, verdict: "ABSENT" })])).toBe(0)
  })
})

describe("abstention accuracy", () => {
  it("refuses a v2 that bought coverage with the `_abs` questions", () => {
    const abs = (judged: boolean) => row({ isAbstention: true, judged })
    const v1 = [...many(54, { judged: false }), abs(true), abs(true), abs(true)]
    // v2 answers three more of the answerable questions and loses two `_abs`.
    const v2 = [...many(54, { judged: true }), abs(true), abs(false), abs(false)]
    const report = readGate(v1, v2)
    expect(report.passed).toBe(false)
    expect(report.numbers["v1AbsCorrect"]).toBe(3)
    expect(report.numbers["v2AbsCorrect"]).toBe(1)
  })
})

describe("the refusals that stand in front of the gate", () => {
  const dev = { split: "dev", prefix: "g3", dataset: "s", extractionGeneration: "extract-v1-abc" }

  it("accepts two files that describe one measurement", () => {
    expect(gateRefusals(dev, dev)).toEqual([])
  })

  it("refuses two files from different graphs", () => {
    // The failure this exists for: two plausible tables, one number, and
    // nothing in the output to say the halves came from different graphs.
    const [refusal] = gateRefusals({ ...dev, prefix: "g2" }, dev)
    expect(refusal).toContain("prefix")
    expect(refusal).toContain("not a comparison")
  })

  it("refuses two files extracted by different prompts", () => {
    expect(gateRefusals({ ...dev, extractionGeneration: "extract-v1-zzz" }, dev)[0]).toContain(
      "extractionGeneration"
    )
  })

  it("refuses a gate read on anything but dev", () => {
    const refusals = gateRefusals({ ...dev, split: "test" }, { ...dev, split: "test" })
    expect(refusals.some((line) => line.includes("read on dev"))).toBe(true)
  })

  it("refuses to gate on an ablation run", () => {
    // An ablation is a different pipeline wearing the same system name, so the
    // gate would be adopting something nobody is proposing to ship.
    const refusals = gateRefusals(dev, { ...dev, ablations: ["noSelect", "noDiscovery"] })
    expect(refusals.some((line) => line.includes("noSelect, noDiscovery"))).toBe(true)
    expect(refusals.some((line) => line.includes("full pipeline"))).toBe(true)
  })

  it("reports every reason at once, not the first", () => {
    // An operator who has to re-run to find the second problem re-runs.
    const refusals = gateRefusals(
      { ...dev, prefix: "g2", dataset: "m" },
      { ...dev, ablations: ["noSelect"] }
    )
    expect(refusals.length).toBeGreaterThanOrEqual(3)
  })
})

describe("the gate is read once", () => {
  it("permits a first read", () => {
    expect(overwriteRefusal(null)).toBeNull()
  })

  it("refuses a second, and names when the first happened", () => {
    // A gate that can be re-read until it passes is not a gate. Overwriting is
    // possible -- by deleting the record by hand, in a commit that says why --
    // and that is deliberately not a flag.
    const refusal = overwriteRefusal({ readAt: "2026-08-31T04:00:00.000Z" })
    expect(refusal).toContain("2026-08-31T04:00:00.000Z")
    expect(refusal).toContain("read once")
    expect(refusal).toContain("by hand")
  })
})
