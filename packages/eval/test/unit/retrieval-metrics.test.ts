import type { DatasetQuestion } from "@palimpsest/dataset"
import type { AskResult } from "@palimpsest/palimpsest"
import { describe, expect, it } from "vitest"
import { gateReport, scoreQuestion, type QuestionRetrieval } from "../../src/index.js"

const date = { raw: "2023/04/10 (Mon) 17:50", ts: 0, dateInt: 20230410 }

const question = (
  id: string,
  answerSessionIds: ReadonlyArray<string>,
  type = "multi-session"
): DatasetQuestion => ({
  questionId: id,
  questionType: type,
  question: "q",
  answer: "a",
  questionDate: date,
  answerSessionIds,
  isAbstention: id.endsWith("_abs"),
  sessions: []
})

const result = (
  verdict: AskResult["verdict"],
  sids: ReadonlyArray<string>,
  reason: AskResult["reason"] = null
): AskResult =>
  ({
    verdict,
    reason,
    evidence: sids.map((sid) => ({ sid, ckey: `c-${sid}` })),
    receipt: { anchorTerms: ["a", "b"], anchorsResolved: ["a"], convergence: [{ convergence: 3 }] },
    hash: "",
    anchors: {}
  }) as unknown as AskResult

describe("scoreQuestion", () => {
  it("counts a hit when any answer-bearing session appears in the evidence", () => {
    const scored = scoreQuestion(question("q1", ["s2"]), result("ANSWER", ["s5", "s2"]), 100)
    expect(scored.sessionHit).toBe(true)
    expect(scored.evidenceSessions).toEqual(["s2", "s5"])
  })

  it("counts a miss when the evidence came entirely from other sessions", () => {
    expect(scoreQuestion(question("q1", ["s2"]), result("ANSWER", ["s5"]), 100).sessionHit).toBe(false)
  })

  it("counts a miss when the system abstained, however confidently", () => {
    const scored = scoreQuestion(question("q1", ["s2"]), result("ABSENT", [], "A2_no_convergence"), 50)
    expect(scored.sessionHit).toBe(false)
    expect(scored.verdict).toBe("ABSENT")
  })
})

const scored = (
  id: string,
  verdict: AskResult["verdict"],
  sessionHit: boolean,
  reason: AskResult["reason"] = null
): QuestionRetrieval => ({
  questionId: id,
  questionType: "multi-session",
  isAbstention: id.endsWith("_abs"),
  verdict,
  reason,
  evidenceSessions: [],
  answerSessions: [],
  sessionHit,
  evidence: sessionHit ? 3 : 0,
  anchorsAsked: 5,
  anchorsResolved: 3,
  topConvergence: 2,
  latencyMs: 1000
})

describe("gateReport", () => {
  it("measures SessionRecall and false-abstention over answerable questions only", () => {
    const report = gateReport([
      scored("a", "ANSWER", true),
      scored("b", "ANSWER", true),
      scored("c", "ANSWER", false),
      scored("d", "ABSENT", false, "A2_no_convergence"),
      // The _abs questions must not dilute either number.
      scored("e_abs", "ABSENT", false, "A1_no_anchors")
    ])
    expect(report.answerable).toBe(4)
    expect(report.sessionRecall).toBe(0.5)
    expect(report.falseAbstention).toBe(0.25)
  })

  it("scores abstention precision and recall against the _abs label", () => {
    const report = gateReport([
      scored("a", "ANSWER", true),
      scored("b", "ABSENT", false, "A2_no_convergence"),
      scored("c_abs", "ABSENT", false, "A1_no_anchors"),
      scored("d_abs", "ANSWER", false)
    ])
    // Refused two, one of which should have been refused.
    expect(report.abstentionPrecision).toBe(0.5)
    // Of the two that should have been refused, one was.
    expect(report.abstentionRecall).toBe(0.5)
    expect(report.a1).toBe(1)
    expect(report.a2).toBe(1)
  })

  it("reports n/a rather than 0 when a slice has no abstention questions", () => {
    const report = gateReport([scored("a", "ANSWER", true)])
    expect(report.abstentionRecall).toBeNull()
    expect(report.abstentionPrecision).toBeNull()
  })

  it("takes the median latency, so one slow question does not dominate", () => {
    const slow = { ...scored("a", "ANSWER", true), latencyMs: 60_000 }
    const report = gateReport([scored("b", "ANSWER", true), scored("c", "ANSWER", true), slow])
    expect(report.medianLatencyMs).toBe(1000)
  })
})
